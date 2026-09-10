-- Durable workflow outcome lineage and terminal local-copy erasure.
-- [COMP:crm/privacy-copies] [COMP:api/workflow-store]
BEGIN;
ALTER TABLE workflow_runs
  ADD COLUMN privacy_lineage_version smallint NOT NULL DEFAULT 0 CHECK(privacy_lineage_version IN(0,1)),
  ADD COLUMN privacy_erased boolean NOT NULL DEFAULT false,
  ADD COLUMN privacy_erased_at timestamptz,
  ADD CONSTRAINT workflow_privacy_erased_shape CHECK (
    (NOT privacy_erased AND privacy_erased_at IS NULL) OR
    (privacy_erased AND privacy_erased_at IS NOT NULL AND status IN('completed','failed','timeout')
      AND input='{}'::jsonb AND vars='{}'::jsonb AND outcome IS NULL AND error IS NULL
      AND triggered_by IS NULL AND trigger_page_id IS NULL AND current_step_id IS NULL)
  );
ALTER TABLE workflow_runs ALTER COLUMN privacy_lineage_version SET DEFAULT 1;
CREATE UNIQUE INDEX workflow_runs_workspace_identity ON workflow_runs(workspace_id,id);
CREATE UNIQUE INDEX workflow_runs_privacy_state ON workflow_runs(workspace_id,id,privacy_erased);
CREATE TABLE workflow_run_copy_sources (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  source_run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,run_id,source_run_id),
  CHECK(run_id<>source_run_id),
  FOREIGN KEY(workspace_id,run_id) REFERENCES workflow_runs(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,source_run_id) REFERENCES workflow_runs(workspace_id,id) ON DELETE NO ACTION
);
CREATE INDEX workflow_run_copy_source_consumers ON workflow_run_copy_sources(workspace_id,source_run_id,run_id);
ALTER TABLE workflow_run_copy_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_run_copy_sources_members ON workflow_run_copy_sources
  USING(workspace_id IN(SELECT workspace_id FROM workspace_members
    WHERE user_id=current_setting('app.current_user_id',true)::uuid))
  WITH CHECK(workspace_id IN(SELECT workspace_id FROM workspace_members
    WHERE user_id=current_setting('app.current_user_id',true)::uuid));

CREATE OR REPLACE FUNCTION public.crm_privacy_guard_workflow_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  previous_workspace uuid;
  next_workspace uuid;
  selected_workspace uuid;
  next_event uuid;
  next_is_crm boolean := false;
  source_ref text;
  available_event uuid;
  next_erased boolean := false;
BEGIN
  IF TG_TABLE_NAME='workflow_runs' THEN
    IF TG_OP<>'INSERT' THEN
      previous_workspace:=OLD.workspace_id;
    END IF;
    IF TG_OP<>'DELETE' THEN
      next_workspace:=NEW.workspace_id;
      next_erased:=NEW.privacy_erased;
      IF TG_OP='UPDATE' THEN
        IF OLD.privacy_erased THEN
          RAISE EXCEPTION 'workflow_privacy_erased' USING ERRCODE='55000';
        END IF;
        IF NEW.privacy_lineage_version IS DISTINCT FROM OLD.privacy_lineage_version THEN
          RAISE EXCEPTION 'workflow_lineage_version_immutable' USING ERRCODE='55000';
        END IF;
        -- Legacy missing-source runs have no FK binding. Do not let mutable
        -- input erase the only remaining attribution before copy resolution.
        IF NOT NEW.privacy_erased AND OLD.crm_event_id IS NULL AND OLD.trigger_kind='event'
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
        WHERE id=OLD.run_id;
    END IF;
    IF TG_OP<>'DELETE' THEN
      SELECT workspace_id,crm_event_id,
          crm_event_id IS NOT NULL OR (trigger_kind='event' AND input#>>'{trigger,sourceType}'='crm'),privacy_erased
          INTO next_workspace,next_event,next_is_crm,next_erased
        FROM workflow_runs WHERE id=NEW.run_id;
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
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='workflow_step_runs' THEN
    SELECT privacy_erased INTO next_erased FROM workflow_runs WHERE id=NEW.run_id FOR KEY SHARE;
    IF next_erased THEN
      RAISE EXCEPTION 'workflow_privacy_erased' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP<>'DELETE' AND next_is_crm AND NOT next_erased THEN
    SELECT id INTO available_event FROM crm_domain_event_outbox
      WHERE id=next_event AND workspace_id=next_workspace AND status<>'retired' FOR KEY SHARE;
    IF available_event IS NULL THEN
      RAISE EXCEPTION 'crm_privacy_source_unavailable' USING ERRCODE='55P03';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE FUNCTION public.workflow_copy_source_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target_workflow uuid; source_workflow uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'workflow_copy_source_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||NEW.workspace_id::text,0)) THEN
    RAISE EXCEPTION 'crm_privacy_operation_busy' USING ERRCODE='55P03';
  END IF;
  SELECT workflow_id INTO target_workflow FROM workflow_runs
    WHERE workspace_id=NEW.workspace_id AND id=NEW.run_id AND NOT privacy_erased FOR KEY SHARE;
  SELECT workflow_id INTO source_workflow FROM workflow_runs
    WHERE workspace_id=NEW.workspace_id AND id=NEW.source_run_id AND NOT privacy_erased FOR KEY SHARE;
  IF target_workflow IS NULL OR source_workflow IS NULL OR target_workflow<>source_workflow THEN
    RAISE EXCEPTION 'workflow_copy_source_unavailable' USING ERRCODE='55P03';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON workflow_run_copy_sources
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write();
CREATE TRIGGER workflow_copy_source_valid BEFORE INSERT OR UPDATE OR DELETE ON workflow_run_copy_sources
  FOR EACH ROW EXECUTE FUNCTION public.workflow_copy_source_admission();

-- Typed artifact and late-audit writers cannot recreate a retired run's copy.
CREATE FUNCTION public.workflow_copy_parent_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE body jsonb; bodies jsonb[]:=ARRAY[]::jsonb[]; reference text;
  scope uuid; erased boolean; minimize_audit boolean:=false;
BEGIN
  IF TG_OP<>'INSERT' THEN bodies:=array_append(bodies,to_jsonb(OLD)); END IF;
  IF TG_OP<>'DELETE' THEN bodies:=array_append(bodies,to_jsonb(NEW)); END IF;
  FOREACH body IN ARRAY bodies LOOP
    reference:=NULL;
    IF TG_TABLE_NAME='pending_approvals' THEN
      reference:=body->>'workflow_run_id';
      IF reference IS NULL AND body->>'workflow_step_run_id' IS NOT NULL THEN
        SELECT run_id::text INTO reference FROM workflow_step_runs WHERE id::text=body->>'workflow_step_run_id';
      END IF;
    ELSIF TG_TABLE_NAME='scheduled_jobs' THEN
      SELECT run_id::text INTO reference FROM workflow_step_runs WHERE id::text=body->>'workflow_step_run_id';
    ELSIF TG_TABLE_NAME='blueprint_records' THEN
      IF body->>'source_kind' IN('workflow','research') THEN reference:=body->>'source_id'; END IF;
    ELSIF TG_TABLE_NAME='workspace_audit_log' THEN
      IF body->>'event_type' LIKE 'workflow.%' THEN reference:=body->>'subject_id'; END IF;
    END IF;
    IF reference IS NULL THEN
      IF TG_OP<>'DELETE' AND TG_TABLE_NAME IN('pending_approvals','scheduled_jobs')
        AND body->>'workflow_step_run_id' IS NOT NULL THEN
        RAISE EXCEPTION 'workflow_copy_source_unavailable' USING ERRCODE='55P03';
      END IF;
      CONTINUE;
    END IF;
    SELECT workspace_id INTO scope FROM workflow_runs WHERE id::text=reference;
    IF scope IS NULL THEN
      IF TG_OP<>'DELETE' AND (TG_TABLE_NAME IN('pending_approvals','scheduled_jobs')
        OR (TG_TABLE_NAME='blueprint_records' AND body->>'source_kind'='workflow')) THEN
        RAISE EXCEPTION 'workflow_copy_source_unavailable' USING ERRCODE='55P03';
      END IF;
      CONTINUE;
    END IF;
    IF body->>'workspace_id' IS NOT NULL AND body->>'workspace_id'<>scope::text THEN
      RAISE EXCEPTION 'workflow_copy_workspace_mismatch' USING ERRCODE='23514';
    END IF;
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||scope::text,0)) THEN
      RAISE EXCEPTION 'crm_privacy_operation_busy' USING ERRCODE='55P03';
    END IF;
    SELECT privacy_erased INTO erased FROM workflow_runs WHERE id::text=reference FOR KEY SHARE;
    IF erased AND TG_OP<>'DELETE' THEN
      IF TG_TABLE_NAME='workspace_audit_log' THEN minimize_audit:=true;
      ELSE RAISE EXCEPTION 'workflow_privacy_erased' USING ERRCODE='55000'; END IF;
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF minimize_audit THEN NEW.details:=jsonb_build_object('erased',true);NEW.actor_user_id:=NULL; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_copy_parent_valid BEFORE INSERT OR UPDATE OR DELETE ON pending_approvals
  FOR EACH ROW EXECUTE FUNCTION public.workflow_copy_parent_admission();
CREATE TRIGGER workflow_copy_parent_valid BEFORE INSERT OR UPDATE OR DELETE ON scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION public.workflow_copy_parent_admission();
CREATE TRIGGER workflow_copy_parent_valid BEFORE INSERT OR UPDATE OR DELETE ON blueprint_records
  FOR EACH ROW EXECUTE FUNCTION public.workflow_copy_parent_admission();
CREATE TRIGGER workflow_copy_parent_valid BEFORE INSERT OR UPDATE OR DELETE ON workspace_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.workflow_copy_parent_admission();

COMMIT;
