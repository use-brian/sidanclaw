-- CRM-owned staging prevents import keys from reading general workspace Files.
-- Spec: docs/architecture/features/crm-operations.md
BEGIN;
CREATE TABLE crm_import_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_key UUID NOT NULL,
  content_bytes BYTEA NOT NULL CHECK (octet_length(content_bytes) BETWEEN 1 AND 31457280),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  credential_id UUID NOT NULL,
  integration_grants JSONB NOT NULL CHECK (jsonb_typeof(integration_grants)='array' AND pg_column_size(integration_grants)<=65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id),
  UNIQUE (workspace_id,source_key),
  FOREIGN KEY (workspace_id,credential_id) REFERENCES crm_integration_credentials(workspace_id,id)
);
ALTER TABLE crm_import_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_import_sources_member_read ON crm_import_sources FOR SELECT
USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));
CREATE FUNCTION public.crm_import_source_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'CRM import source bytes and authority are immutable; stage a new source';
END;
$$;
CREATE TRIGGER crm_import_source_no_update BEFORE UPDATE ON crm_import_sources
FOR EACH ROW EXECUTE FUNCTION public.crm_import_source_immutable();

ALTER TABLE crm_import_jobs ALTER COLUMN staged_file_id DROP NOT NULL;
ALTER TABLE crm_import_jobs ADD COLUMN source_id UUID;
ALTER TABLE crm_import_jobs ADD COLUMN integration_credential_id UUID;
ALTER TABLE crm_import_jobs ADD COLUMN integration_grants JSONB;
ALTER TABLE crm_import_jobs ADD CONSTRAINT crm_import_jobs_source_fk
  FOREIGN KEY (workspace_id,source_id) REFERENCES crm_import_sources(workspace_id,id);
ALTER TABLE crm_import_jobs ADD CONSTRAINT crm_import_jobs_credential_fk
  FOREIGN KEY (workspace_id,integration_credential_id) REFERENCES crm_integration_credentials(workspace_id,id);
ALTER TABLE crm_import_jobs ADD CONSTRAINT crm_import_jobs_one_source
  CHECK (num_nonnulls(staged_file_id,source_id)=1);
ALTER TABLE crm_import_jobs ADD CONSTRAINT crm_import_jobs_integration_ceiling
  CHECK ((source_id IS NULL AND integration_credential_id IS NULL AND integration_grants IS NULL)
    OR (source_id IS NOT NULL AND integration_credential_id IS NOT NULL AND integration_grants IS NOT NULL
      AND jsonb_typeof(integration_grants)='array' AND pg_column_size(integration_grants)<=65536));
CREATE FUNCTION public.crm_import_job_input_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF ROW(OLD.workspace_id,OLD.staged_file_id,OLD.source_id,OLD.integration_credential_id,
      OLD.integration_grants,OLD.entity_kind,OLD.mapping,OLD.mapping_hash,OLD.source_hash,OLD.trusted_identity)
    IS DISTINCT FROM ROW(NEW.workspace_id,NEW.staged_file_id,NEW.source_id,NEW.integration_credential_id,
      NEW.integration_grants,NEW.entity_kind,NEW.mapping,NEW.mapping_hash,NEW.source_hash,NEW.trusted_identity) THEN
    RAISE EXCEPTION 'CRM import job input and authority are immutable; confirm a new job';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_import_job_input_no_update BEFORE UPDATE ON crm_import_jobs
FOR EACH ROW EXECUTE FUNCTION public.crm_import_job_input_immutable();
COMMIT;
