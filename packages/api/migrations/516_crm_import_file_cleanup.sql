-- Durable live-object cleanup after reviewed source retirement. [COMP:crm/file-cleanup]
BEGIN;
CREATE TABLE crm_import_file_cleanups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  file_id uuid NOT NULL,
  before_at timestamptz NOT NULL,
  policy_version integer NOT NULL CHECK(policy_version>=0),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
  summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object' AND pg_column_size(summary)<=65536),
  status text NOT NULL CHECK(status IN('ready','blocked','queued','leased','failed','completed')),
  storage_uri text CHECK(storage_uri IS NULL OR length(storage_uri) BETWEEN 1 AND 4096),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  leased_until timestamptz,
  error_code text CHECK(error_code IS NULL OR error_code='file_cleanup_failed'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  queued_at timestamptz,
  completed_at timestamptz,
  replay_expires_at timestamptz,
  UNIQUE(workspace_id,id),
  CHECK(expires_at>created_at),
  CHECK((status IN('queued','leased','failed'))=(storage_uri IS NOT NULL)),
  CHECK((status IN('queued','leased','failed','completed'))=(queued_at IS NOT NULL)),
  CHECK((queued_at IS NOT NULL)=(replay_expires_at IS NOT NULL)),
  CHECK(replay_expires_at IS NULL OR replay_expires_at>queued_at),
  CHECK((status='leased')=(lease_token IS NOT NULL)),
  CHECK((status='leased')=(leased_until IS NOT NULL)),
  CHECK((status='completed')=(completed_at IS NOT NULL)),
  CHECK((status='failed')=(error_code IS NOT NULL))
);
CREATE UNIQUE INDEX crm_import_file_cleanup_committed ON crm_import_file_cleanups(workspace_id,file_id)
  WHERE queued_at IS NOT NULL;
CREATE INDEX crm_import_file_cleanup_due ON crm_import_file_cleanups(next_attempt_at,workspace_id,id)
  WHERE status IN('queued','failed','leased');
ALTER TABLE crm_import_file_cleanups ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_import_file_cleanups_owner_read ON crm_import_file_cleanups FOR SELECT USING(
  workspace_id IN(SELECT workspace_id FROM workspace_members
    WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN('owner','admin')));
CREATE FUNCTION public.crm_import_file_cleanup_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.owner_user_id IS NULL AND to_jsonb(NEW)-'owner_user_id'=to_jsonb(OLD)-'owner_user_id' THEN RETURN NEW; END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.owner_user_id,NEW.file_id,NEW.before_at,NEW.policy_version,NEW.snapshot_hash,
    NEW.preview_hash,NEW.summary,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.owner_user_id,OLD.file_id,OLD.before_at,OLD.policy_version,OLD.snapshot_hash,
    OLD.preview_hash,OLD.summary,OLD.created_at,OLD.expires_at)
    OR NOT((OLD.status='ready' AND NEW.status='queued')
      OR (OLD.status IN('queued','failed') AND NEW.status='leased')
      OR (OLD.status='leased' AND NEW.status IN('completed','failed'))
      OR (OLD.status='leased' AND NEW.status='leased' AND OLD.leased_until<=clock_timestamp()))
  THEN RAISE EXCEPTION 'CRM file cleanup identity is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.queued_at IS NOT NULL AND ROW(NEW.queued_at,NEW.replay_expires_at) IS DISTINCT FROM ROW(OLD.queued_at,OLD.replay_expires_at)
    OR (OLD.storage_uri IS NOT NULL AND NEW.storage_uri IS DISTINCT FROM OLD.storage_uri AND NEW.status<>'completed')
  THEN RAISE EXCEPTION 'CRM file cleanup target is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_import_file_cleanup_no_edit BEFORE UPDATE ON crm_import_file_cleanups
  FOR EACH ROW EXECUTE FUNCTION public.crm_import_file_cleanup_immutable();
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON crm_import_file_cleanups
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write();
-- File history can arrive asynchronously after the canonical index is gone.
-- Lock the live parent to close that race; allow only minimized absent-parent
-- audit. This also prevents a stale snapshot from restoring copied content.
CREATE FUNCTION public.crm_file_copy_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ws uuid; target uuid;
BEGIN
  IF TG_TABLE_NAME='brain_row_versions' THEN
    IF NEW.primitive<>'workspace_file' THEN RETURN NEW; END IF;
    target:=NEW.row_id;
  ELSIF TG_TABLE_NAME='correction_audit' THEN
    IF NEW.primitive<>'workspace_file' THEN RETURN NEW; END IF;
    target:=NEW.row_id;
  ELSE
    IF NEW.event_type NOT LIKE 'file.%' OR NEW.subject_id IS NULL THEN RETURN NEW; END IF;
    target:=NEW.subject_id;
  END IF;
  SELECT workspace_id INTO ws FROM workspace_files WHERE id=target FOR KEY SHARE;
  IF ws IS NOT NULL AND (NEW.workspace_id IS NULL OR NEW.workspace_id=ws) THEN
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||ws::text,0)) THEN
      RAISE EXCEPTION 'crm_privacy_operation_busy' USING ERRCODE='55P03';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='brain_row_versions' THEN
    IF NEW.before_image IS NOT NULL THEN RAISE EXCEPTION 'crm_privacy_subject_unavailable' USING ERRCODE='55P03'; END IF;
    NEW.mutation_reason:='Source data erased';
  ELSIF TG_TABLE_NAME='correction_audit' THEN
    NEW.reason:='Source data erased'; NEW.ticket_reference:=NULL;
    NEW.row_snapshot:=jsonb_build_object('erased',true); NEW.detail:=jsonb_build_object('erased',true);
  ELSE
    NEW.details:=jsonb_build_object('erased',true);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_file_copy_parent_valid BEFORE INSERT OR UPDATE ON brain_row_versions
  FOR EACH ROW EXECUTE FUNCTION public.crm_file_copy_parent();
CREATE TRIGGER crm_file_copy_parent_valid BEFORE INSERT OR UPDATE ON correction_audit
  FOR EACH ROW EXECUTE FUNCTION public.crm_file_copy_parent();
CREATE TRIGGER crm_file_copy_parent_valid BEFORE INSERT OR UPDATE ON workspace_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.crm_file_copy_parent();
COMMIT;
