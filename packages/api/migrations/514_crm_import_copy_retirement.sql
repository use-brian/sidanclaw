-- Canonical retirement of fully attributed CRM CSV sources. [COMP:crm/privacy-copies]
BEGIN;
CREATE FUNCTION public.crm_import_source_policy_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; ids uuid[]:=ARRAY[]::uuid[];
BEGIN
  IF value IS NULL OR value='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(value)<>'object' OR NOT value ?& ARRAY['receiptRetentionSeconds','heldSourceIds']
    OR value-ARRAY['receiptRetentionSeconds','heldSourceIds']<>'{}'::jsonb
    OR jsonb_typeof(value->'receiptRetentionSeconds')<>'number'
    OR jsonb_typeof(value->'heldSourceIds')<>'array' THEN RETURN false; END IF;
  IF (value->>'receiptRetentionSeconds')::numeric NOT BETWEEN 1 AND 2147483647
    OR trunc((value->>'receiptRetentionSeconds')::numeric)<>(value->>'receiptRetentionSeconds')::numeric
    OR jsonb_array_length(value->'heldSourceIds')>250 THEN RETURN false; END IF;
  FOR item IN SELECT jsonb_array_elements(value->'heldSourceIds') LOOP
    IF jsonb_typeof(item)<>'string' THEN RETURN false; END IF;
    ids:=array_append(ids,(item#>>'{}')::uuid);
  END LOOP;
  RETURN cardinality(ids)=(SELECT count(DISTINCT id) FROM unnest(ids) id);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;
ALTER TABLE crm_privacy_policies DROP CONSTRAINT crm_privacy_policies_policy_check;
ALTER TABLE crm_privacy_policies ADD CONSTRAINT crm_privacy_policies_policy_check CHECK ((
  jsonb_typeof(policy)='object' AND policy ? 'intakeReplay'
  AND policy - ARRAY['intakeReplay','addressSuppression','importSourceErasure']::text[] = '{}'::jsonb
  AND (policy->'intakeReplay'='null'::jsonb OR (
    jsonb_typeof(policy->'intakeReplay')='object'
    AND policy->'intakeReplay' ? 'retentionSeconds'
    AND (policy->'intakeReplay') - 'retentionSeconds'='{}'::jsonb
    AND jsonb_typeof(policy->'intakeReplay'->'retentionSeconds')='number'
    AND (policy->'intakeReplay'->>'retentionSeconds')::numeric BETWEEN 1 AND 2147483647
    AND trunc((policy->'intakeReplay'->>'retentionSeconds')::numeric)=(policy->'intakeReplay'->>'retentionSeconds')::numeric))
  AND (NOT policy ? 'addressSuppression' OR policy->'addressSuppression'='null'::jsonb OR (
    jsonb_typeof(policy->'addressSuppression')='object'
    AND policy->'addressSuppression' ? 'retentionSeconds'
    AND (policy->'addressSuppression') - 'retentionSeconds'='{}'::jsonb
    AND jsonb_typeof(policy->'addressSuppression'->'retentionSeconds')='number'
    AND (policy->'addressSuppression'->>'retentionSeconds')::numeric BETWEEN 1 AND 2147483647
    AND trunc((policy->'addressSuppression'->>'retentionSeconds')::numeric)=(policy->'addressSuppression'->>'retentionSeconds')::numeric))
  AND public.crm_import_source_policy_valid(policy->'importSourceErasure')
) IS TRUE);

ALTER TABLE crm_import_sources
  ADD COLUMN privacy_lineage_version smallint NOT NULL DEFAULT 0 CHECK(privacy_lineage_version IN(0,1)),
  ADD COLUMN privacy_erased boolean NOT NULL DEFAULT false,
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN replay_expires_at timestamptz,
  ADD COLUMN replay_policy_version integer,
  DROP CONSTRAINT crm_import_sources_content_bytes_check,
  ADD CONSTRAINT crm_import_source_retired_shape CHECK(
    (NOT privacy_erased AND retired_at IS NULL AND replay_expires_at IS NULL AND replay_policy_version IS NULL
      AND octet_length(content_bytes) BETWEEN 1 AND 31457280)
    OR (privacy_erased AND retired_at IS NOT NULL AND replay_expires_at IS NOT NULL AND replay_expires_at>retired_at AND replay_policy_version IS NOT NULL
      AND octet_length(content_bytes)=0 AND source_hash=repeat('0',64) AND integration_grants='[]'::jsonb)),
  ADD FOREIGN KEY(workspace_id,replay_policy_version) REFERENCES crm_privacy_policies(workspace_id,version);
ALTER TABLE crm_import_sources ALTER COLUMN privacy_lineage_version SET DEFAULT 1;
CREATE INDEX crm_import_source_content_copies ON crm_import_sources(workspace_id,source_hash);
CREATE UNIQUE INDEX crm_import_source_privacy_state ON crm_import_sources(workspace_id,id,privacy_erased);
ALTER TABLE crm_import_jobs
  ADD COLUMN privacy_erased boolean NOT NULL DEFAULT false,
  ADD COLUMN privacy_erased_at timestamptz,
  ADD CONSTRAINT crm_import_job_retired_shape CHECK(
    (NOT privacy_erased AND privacy_erased_at IS NULL) OR
    (privacy_erased AND privacy_erased_at IS NOT NULL AND status='completed' AND source_id IS NOT NULL
      AND mapping='{"columns":{}}'::jsonb AND mapping_hash=repeat('0',64) AND source_hash=repeat('0',64)
      AND NOT trusted_identity AND integration_grants='[]'::jsonb
      AND created_by_user_id IS NULL AND confirmed_by_user_id IS NULL));
CREATE INDEX crm_import_jobs_source_consumers ON crm_import_jobs(workspace_id,source_id,id);
CREATE UNIQUE INDEX crm_import_job_privacy_state ON crm_import_jobs(workspace_id,id,privacy_erased);
CREATE OR REPLACE FUNCTION public.crm_import_source_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.privacy_erased THEN RAISE EXCEPTION 'import_source_retired' USING ERRCODE='55000'; END IF;
  -- Deleting a historical job destroys proof of the complete consumer set.
  IF OLD.privacy_lineage_version=1 AND NEW.privacy_lineage_version=0
    AND to_jsonb(OLD)-'privacy_lineage_version'=to_jsonb(NEW)-'privacy_lineage_version' THEN RETURN NEW; END IF;
  IF NEW.privacy_erased AND to_jsonb(OLD)-ARRAY['content_bytes','source_hash','integration_grants','privacy_erased','retired_at','replay_expires_at','replay_policy_version']
    =to_jsonb(NEW)-ARRAY['content_bytes','source_hash','integration_grants','privacy_erased','retired_at','replay_expires_at','replay_policy_version']
    AND NOT EXISTS(SELECT 1 FROM crm_import_jobs WHERE workspace_id=OLD.workspace_id AND source_id=OLD.id AND NOT privacy_erased)
    THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'CRM import source bytes and authority are immutable; stage a new source' USING ERRCODE='55000';
END;
$$;
CREATE OR REPLACE FUNCTION public.crm_import_job_input_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.privacy_erased THEN RAISE EXCEPTION 'import_job_retired' USING ERRCODE='55000'; END IF;
  IF NEW.privacy_erased AND OLD.status='completed'
    AND to_jsonb(OLD)-ARRAY['mapping','mapping_hash','source_hash','trusted_identity','integration_grants','created_by_user_id','confirmed_by_user_id','updated_at','privacy_erased','privacy_erased_at']
      =to_jsonb(NEW)-ARRAY['mapping','mapping_hash','source_hash','trusted_identity','integration_grants','created_by_user_id','confirmed_by_user_id','updated_at','privacy_erased','privacy_erased_at']
    THEN RETURN NEW; END IF;
  IF NEW.privacy_erased OR ROW(OLD.workspace_id,OLD.staged_file_id,OLD.source_id,OLD.integration_credential_id,
      OLD.integration_grants,OLD.entity_kind,OLD.mapping,OLD.mapping_hash,OLD.source_hash,OLD.trusted_identity)
    IS DISTINCT FROM ROW(NEW.workspace_id,NEW.staged_file_id,NEW.source_id,NEW.integration_credential_id,
      NEW.integration_grants,NEW.entity_kind,NEW.mapping,NEW.mapping_hash,NEW.source_hash,NEW.trusted_identity) THEN
    RAISE EXCEPTION 'CRM import job input and authority are immutable; confirm a new job' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.crm_import_copy_parent_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE available uuid;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||NEW.workspace_id::text,0)) THEN
    RAISE EXCEPTION 'crm_privacy_operation_busy' USING ERRCODE='55P03';
  END IF;
  IF TG_TABLE_NAME='crm_import_jobs' THEN
    IF TG_OP='INSERT' AND NEW.privacy_erased THEN
      RAISE EXCEPTION 'import_job_retired' USING ERRCODE='55000';
    END IF;
    IF NEW.source_id IS NULL OR NEW.privacy_erased THEN RETURN NEW; END IF;
    SELECT id INTO available FROM crm_import_sources
      WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id AND NOT privacy_erased FOR KEY SHARE;
    IF available IS NULL THEN RAISE EXCEPTION 'import_source_retired' USING ERRCODE='55000'; END IF;
  ELSE
    IF TG_OP='UPDATE' AND ROW(OLD.workspace_id,OLD.job_id) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.job_id) THEN
      RAISE EXCEPTION 'import_copy_parent_immutable' USING ERRCODE='55000';
    END IF;
    SELECT id INTO available FROM crm_import_jobs
      WHERE workspace_id=NEW.workspace_id AND id=NEW.job_id AND NOT privacy_erased FOR KEY SHARE;
    IF available IS NULL THEN RAISE EXCEPTION 'import_job_retired' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_import_source_admission BEFORE INSERT OR UPDATE ON crm_import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.crm_import_copy_parent_admission();
-- Member RLS allows job deletion but sources deliberately have no UPDATE
-- policy. Record loss with a narrowly bound definer trigger so invoker RLS
-- cannot silently hide the source from its bookkeeping update.
CREATE FUNCTION public.crm_import_record_consumer_loss() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source uuid;
BEGIN
  IF TG_RELID='public.crm_import_jobs'::regclass AND TG_OP='DELETE' THEN
    source:=OLD.source_id;
  ELSIF TG_RELID='public.crm_import_rows'::regclass AND TG_OP IN('DELETE','UPDATE') THEN
    IF TG_OP='UPDATE' AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id THEN RETURN NEW; END IF;
    SELECT source_id INTO source FROM public.crm_import_jobs
      WHERE workspace_id=OLD.workspace_id AND id=OLD.job_id AND NOT privacy_erased;
  ELSE
    RAISE EXCEPTION 'CRM import lineage hook requires canonical relation' USING ERRCODE='55000';
  END IF;
  IF source IS NOT NULL THEN
    UPDATE public.crm_import_sources SET privacy_lineage_version=0
      WHERE workspace_id=OLD.workspace_id AND id=source
        AND NOT privacy_erased AND privacy_lineage_version=1;
  END IF;
  IF TG_OP='UPDATE' THEN RETURN NEW; ELSE RETURN OLD; END IF;
END;
$$;
CREATE TRIGGER crm_import_row_attribution_loss BEFORE DELETE OR UPDATE ON crm_import_rows
  FOR EACH ROW EXECUTE FUNCTION public.crm_import_record_consumer_loss();
CREATE TRIGGER crm_import_consumer_loss BEFORE DELETE ON crm_import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.crm_import_record_consumer_loss();
DO $$ DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['crm_import_rows','crm_import_chunks','crm_import_errors'] LOOP
    EXECUTE format('CREATE TRIGGER crm_import_parent_admission BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.crm_import_copy_parent_admission()',relation);
  END LOOP;
END;
$$;
COMMIT;
