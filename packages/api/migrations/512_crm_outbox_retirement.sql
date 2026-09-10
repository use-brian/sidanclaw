-- Retired delivery intents and durable CRM workflow-copy attribution.
-- [COMP:crm/domain-events] [COMP:crm/privacy-copies]
BEGIN;

ALTER TABLE crm_domain_event_outbox
  DROP CONSTRAINT crm_domain_event_outbox_status_check,
  ADD CONSTRAINT crm_domain_event_outbox_status_check
    CHECK (status IN ('pending','leased','delivered','failed','retired')),
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_from_status text
    CHECK (retired_from_status IN ('pending','leased','delivered','failed')),
  ADD CONSTRAINT crm_domain_event_retirement_shape CHECK (
    (status='retired' AND retired_at IS NOT NULL AND retired_from_status IS NOT NULL)
    OR (status<>'retired' AND retired_at IS NULL AND retired_from_status IS NULL)
  );
ALTER TABLE association_notification_outbox
  DROP CONSTRAINT association_notification_outbox_status_check,
  ADD CONSTRAINT association_notification_outbox_status_check
    CHECK (status IN ('pending','sending','sent','failed','suppressed','retired')),
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_from_status text
    CHECK (retired_from_status IN ('pending','sending','sent','failed','suppressed')),
  ADD CONSTRAINT association_notification_retirement_shape CHECK (
    (status='retired' AND retired_at IS NOT NULL AND retired_from_status IS NOT NULL)
    OR (status<>'retired' AND retired_at IS NULL AND retired_from_status IS NULL)
  );

-- Older canonical erasure already cleared these exact payloads. Their old
-- pending/leased state must not make the minimal receipt dispatchable again.
UPDATE crm_domain_event_outbox SET retired_from_status=status,status='retired',
  retired_at=clock_timestamp(),lease_owner=NULL,leased_until=NULL,last_error=NULL
WHERE subject_id='00000000-0000-0000-0000-000000000000'::uuid
  AND payload=jsonb_build_object('erased',true,'eventType',event_type);

CREATE FUNCTION public.crm_guard_retired_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status='retired' THEN
    RAISE EXCEPTION 'crm_delivery_retired' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_retired_outbox_immutable BEFORE UPDATE ON crm_domain_event_outbox
  FOR EACH ROW EXECUTE FUNCTION public.crm_guard_retired_outbox();
CREATE TRIGGER crm_retired_outbox_immutable BEFORE UPDATE ON association_notification_outbox
  FOR EACH ROW EXECUTE FUNCTION public.crm_guard_retired_outbox();

CREATE UNIQUE INDEX crm_domain_event_workspace_id ON crm_domain_event_outbox(workspace_id,id);
-- Status is a protected key: retirement must conflict with key-share source
-- admission even for a transaction whose repeatable-read snapshot predates it.
-- The worker holds NO KEY UPDATE while enqueue uses KEY SHARE; status changes
-- occur only after that separately committed enqueue returns.
CREATE UNIQUE INDEX crm_domain_event_dispatch_state ON crm_domain_event_outbox(workspace_id,id,status);
ALTER TABLE workflow_runs ADD COLUMN crm_event_id uuid;
UPDATE workflow_runs r SET crm_event_id=e.id FROM crm_domain_event_outbox e
WHERE r.workspace_id=e.workspace_id AND r.trigger_kind='event' AND r.input#>>'{trigger,sourceType}'='crm'
  AND r.input#>>'{event,domainEventId}'=e.id::text;
-- An unavailable historical source is a failed run, never a poisoned pending
-- queue item. Its inputs/outputs remain explicit privacy dependencies.
UPDATE workflow_runs r SET status='failed',finished_at=COALESCE(finished_at,clock_timestamp()),
  error=jsonb_build_object('code','crm_privacy_source_unavailable','message','CRM event source is unavailable')
WHERE r.trigger_kind='event' AND r.input#>>'{trigger,sourceType}'='crm'
  AND r.status IN('pending','running','awaiting_wait','awaiting_input')
  AND NOT EXISTS(SELECT 1 FROM crm_domain_event_outbox e
    WHERE e.workspace_id=r.workspace_id AND e.id=r.crm_event_id AND e.status<>'retired');
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_crm_event_workspace_fk
  FOREIGN KEY(workspace_id,crm_event_id)
  REFERENCES crm_domain_event_outbox(workspace_id,id) ON DELETE NO ACTION;
CREATE INDEX workflow_runs_crm_event ON workflow_runs(workspace_id,crm_event_id)
  WHERE crm_event_id IS NOT NULL;

-- Run input is mutable. Preserve its original typed event binding separately.
-- Step rows derive their privacy scope from the parent, without a guessed
-- workspace or a generic JSON substring search.
CREATE FUNCTION public.crm_privacy_guard_workflow_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  previous_workspace uuid;
  next_workspace uuid;
  selected_workspace uuid;
  next_event uuid;
  next_is_crm boolean := false;
  source_ref text;
  available_event uuid;
BEGIN
  IF TG_TABLE_NAME='workflow_runs' THEN
    IF TG_OP<>'INSERT' THEN
      IF OLD.crm_event_id IS NOT NULL OR (OLD.trigger_kind='event' AND OLD.input#>>'{trigger,sourceType}'='crm') THEN
        previous_workspace:=OLD.workspace_id;
      END IF;
    END IF;
    IF TG_OP<>'DELETE' THEN
      IF TG_OP='UPDATE' THEN
        -- Legacy missing-source runs have no FK binding. Do not let mutable
        -- input erase the only remaining attribution before copy resolution.
        IF OLD.crm_event_id IS NULL AND OLD.trigger_kind='event'
          AND OLD.input#>>'{trigger,sourceType}'='crm'
          AND (NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
            OR NEW.input IS DISTINCT FROM OLD.input) THEN
          RAISE EXCEPTION 'crm_workflow_source_immutable' USING ERRCODE='55000';
        END IF;
        IF OLD.crm_event_id IS NOT NULL THEN
          IF NEW.crm_event_id IS DISTINCT FROM OLD.crm_event_id THEN
            RAISE EXCEPTION 'crm_workflow_source_immutable' USING ERRCODE='55000';
          END IF;
        END IF;
      END IF;
      next_is_crm:=NEW.crm_event_id IS NOT NULL OR COALESCE(NEW.trigger_kind='event' AND NEW.input#>>'{trigger,sourceType}'='crm',false);
      IF next_is_crm THEN
        next_workspace:=NEW.workspace_id;
        next_event:=NEW.crm_event_id;
        source_ref:=NEW.input#>>'{event,domainEventId}';
        IF next_event IS NULL THEN
          SELECT id INTO next_event FROM crm_domain_event_outbox
            WHERE workspace_id=next_workspace AND id::text=source_ref;
          NEW.crm_event_id:=next_event;
        ELSIF NEW.trigger_kind='event' AND NEW.input#>>'{trigger,sourceType}'='crm'
          AND source_ref IS DISTINCT FROM next_event::text THEN
          RAISE EXCEPTION 'crm_workflow_source_immutable' USING ERRCODE='55000';
        END IF;
      END IF;
    END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN
      SELECT workspace_id INTO previous_workspace FROM workflow_runs
        WHERE id=OLD.run_id AND (crm_event_id IS NOT NULL OR (trigger_kind='event' AND input#>>'{trigger,sourceType}'='crm'));
    END IF;
    IF TG_OP<>'DELETE' THEN
      SELECT workspace_id,crm_event_id,true INTO next_workspace,next_event,next_is_crm
        FROM workflow_runs WHERE id=NEW.run_id
          AND (crm_event_id IS NOT NULL OR (trigger_kind='event' AND input#>>'{trigger,sourceType}'='crm'));
    END IF;
  END IF;
  FOR selected_workspace IN
    SELECT DISTINCT w FROM unnest(ARRAY[previous_workspace,next_workspace]) w
      WHERE w IS NOT NULL ORDER BY w
  LOOP
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||selected_workspace::text,0)) THEN
      RAISE EXCEPTION 'crm_privacy_operation_busy' USING ERRCODE='55P03';
    END IF;
  END LOOP;
  IF TG_OP<>'DELETE' AND next_is_crm THEN
    SELECT id INTO available_event FROM crm_domain_event_outbox
      WHERE id=next_event AND workspace_id=next_workspace AND status<>'retired' FOR KEY SHARE;
    IF available_event IS NULL THEN
      RAISE EXCEPTION 'crm_privacy_source_unavailable' USING ERRCODE='55P03';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_workflow_write();
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON workflow_step_runs
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_workflow_write();

COMMIT;
