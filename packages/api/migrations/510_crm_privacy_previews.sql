-- Owner-bound, reviewed erasure receipts. [COMP:crm/privacy-previews]
BEGIN;
CREATE TABLE crm_privacy_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id uuid,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
  policy_version integer NOT NULL CHECK(policy_version>=0),
  domain_summary jsonb NOT NULL CHECK(jsonb_typeof(domain_summary)='array' AND pg_column_size(domain_summary)<=65536),
  blockers jsonb NOT NULL CHECK(jsonb_typeof(blockers)='array' AND pg_column_size(blockers)<=65536),
  status text NOT NULL CHECK(status IN('ready','blocked','consumed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  receipt jsonb,
  UNIQUE(workspace_id,id),
  CHECK(expires_at>created_at),
  CHECK((status='consumed')=(subject_id IS NULL)),
  CHECK((status='consumed')=(consumed_at IS NOT NULL)),
  CHECK((status='consumed')=(receipt IS NOT NULL)),
  CHECK(receipt IS NULL OR jsonb_typeof(receipt)='object'),
  CHECK(status<>'ready' OR jsonb_array_length(blockers)=0),
  CHECK(status<>'blocked' OR jsonb_array_length(blockers)>0)
);
CREATE INDEX crm_privacy_previews_owner ON crm_privacy_previews(workspace_id,owner_user_id,created_at DESC);
ALTER TABLE crm_privacy_previews ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_privacy_previews_owner_read ON crm_privacy_previews FOR SELECT
  USING(owner_user_id=current_setting('app.current_user_id',true)::uuid
    AND workspace_id IN(SELECT workspace_id FROM workspace_members
      WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN('owner','admin')));
CREATE FUNCTION public.crm_privacy_preview_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status<>'ready' OR NEW.status<>'consumed'
    OR ROW(NEW.id,NEW.workspace_id,NEW.owner_user_id,NEW.request_hash,NEW.snapshot_hash,NEW.preview_hash,
      NEW.policy_version,NEW.domain_summary,NEW.blockers,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.owner_user_id,OLD.request_hash,OLD.snapshot_hash,OLD.preview_hash,
      OLD.policy_version,OLD.domain_summary,OLD.blockers,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'CRM privacy previews are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_privacy_preview_no_edit BEFORE UPDATE ON crm_privacy_previews
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_preview_immutable();
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON crm_privacy_previews
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write();
COMMIT;
