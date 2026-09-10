-- Task copies participate in canonical CRM erasure. [COMP:crm/privacy-copies]
BEGIN;
CREATE INDEX idx_tasks_privacy_superseded_by ON tasks(superseded_by) WHERE superseded_by IS NOT NULL;

CREATE OR REPLACE FUNCTION public.crm_privacy_guard_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  previous_workspace uuid;
  next_workspace uuid;
  selected_workspace uuid;
  canonical_workspace uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN previous_workspace:=OLD.workspace_id; END IF;
  IF TG_OP<>'DELETE' THEN next_workspace:=NEW.workspace_id; END IF;
  -- The generic history sidecar has legacy null-workspace rows. CRM
  -- snapshots are attributable by their live canonical parent and may not
  -- recreate a non-null before-image after that parent was purged.
  IF TG_TABLE_NAME='brain_row_versions' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.primitive NOT IN('entity','contact','company','deal','task') THEN RETURN NEW; END IF;
    ELSIF TG_OP='DELETE' THEN
      IF OLD.primitive NOT IN('entity','contact','company','deal','task') THEN RETURN OLD; END IF;
    ELSE
      IF OLD.primitive NOT IN('entity','contact','company','deal','task')
        AND NEW.primitive NOT IN('entity','contact','company','deal','task') THEN RETURN NEW; END IF;
    END IF;
    IF TG_OP<>'INSERT' THEN
      IF previous_workspace IS NULL AND OLD.primitive IN('entity','contact','company','deal','task') THEN
        IF OLD.primitive='task' THEN
          SELECT workspace_id INTO previous_workspace FROM tasks WHERE id=OLD.row_id;
        ELSE
          SELECT workspace_id INTO previous_workspace FROM entities WHERE id=OLD.row_id;
        END IF;
      END IF;
    END IF;
    IF TG_OP<>'DELETE' THEN
      IF NEW.primitive IN('entity','contact','company','deal','task') THEN
        IF NEW.primitive='task' THEN
          SELECT workspace_id INTO canonical_workspace FROM tasks WHERE id=NEW.row_id;
        ELSE
          SELECT workspace_id INTO canonical_workspace FROM entities WHERE id=NEW.row_id;
        END IF;
        IF next_workspace IS NULL THEN next_workspace:=canonical_workspace; END IF;
        IF NEW.before_image IS NOT NULL AND (canonical_workspace IS NULL OR next_workspace<>canonical_workspace) THEN
          RAISE EXCEPTION 'crm_privacy_subject_unavailable' USING ERRCODE='55P03';
        END IF;
      END IF;
    END IF;
  END IF;
  FOR selected_workspace IN
    SELECT DISTINCT w FROM unnest(ARRAY[previous_workspace,next_workspace]) w
    WHERE w IS NOT NULL ORDER BY w
  LOOP
    -- A row may already be locked before this trigger runs. Waiting for the
    -- privacy holder would reverse its advisory -> row order and deadlock.
    IF NOT pg_try_advisory_xact_lock_shared(
      hashtextextended('crm-privacy-admission:'||selected_workspace::text,0)
    ) THEN
      RAISE EXCEPTION 'crm_privacy_operation_busy' USING ERRCODE='55P03';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

COMMIT;
