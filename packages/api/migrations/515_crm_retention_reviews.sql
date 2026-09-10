-- Reviewed policy retention, with no scheduled defaults. [COMP:crm/retention]
BEGIN;
CREATE FUNCTION public.crm_retention_policy_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE key text; item jsonb; refs text[]:=ARRAY[]::text[]; n numeric;
BEGIN
  IF value IS NULL OR value='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(value)<>'object' OR NOT value ?& ARRAY['scheduled','intervalSeconds','resolvedSubmissionsSeconds',
    'openSubmissions','importReceiptsSeconds','deliveryReceiptsSeconds','auditSeconds','financialRecordsSeconds','holds']
    OR value-ARRAY['scheduled','intervalSeconds','resolvedSubmissionsSeconds','openSubmissions','importReceiptsSeconds',
      'deliveryReceiptsSeconds','auditSeconds','financialRecordsSeconds','holds']<>'{}'::jsonb
    OR jsonb_typeof(value->'scheduled')<>'boolean' OR jsonb_typeof(value->'intervalSeconds')<>'number'
    OR jsonb_typeof(value->'holds')<>'array' THEN RETURN false; END IF;
  n:=(value->>'intervalSeconds')::numeric;
  IF n NOT BETWEEN 60 AND 86400 OR n<>trunc(n) OR jsonb_array_length(value->'holds')>500 THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['resolvedSubmissionsSeconds','importReceiptsSeconds','deliveryReceiptsSeconds','auditSeconds','financialRecordsSeconds'] LOOP
    IF value->key<>'null'::jsonb THEN
      IF jsonb_typeof(value->key)<>'number' THEN RETURN false; END IF;
      n:=(value->>key)::numeric;
      IF n NOT BETWEEN 1 AND 2147483647 OR n<>trunc(n) THEN RETURN false; END IF;
    END IF;
  END LOOP;
  IF value->'openSubmissions'<>'null'::jsonb THEN
    item:=value->'openSubmissions';
    IF jsonb_typeof(item)<>'object' OR NOT item ?& ARRAY['afterSeconds','fields']
      OR item-ARRAY['afterSeconds','fields']<>'{}'::jsonb
      OR jsonb_typeof(item->'afterSeconds')<>'number' OR jsonb_typeof(item->'fields')<>'array' THEN RETURN false; END IF;
    n:=(item->>'afterSeconds')::numeric;
    IF n NOT BETWEEN 1 AND 2147483647 OR n<>trunc(n) OR jsonb_array_length(item->'fields') NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
    FOR key IN SELECT jsonb_array_elements_text(item->'fields') LOOP
      IF key IS NULL OR key NOT IN('subject','message','metadata','notes') OR key=ANY(refs) THEN RETURN false; END IF;
      refs:=array_append(refs,key);
    END LOOP;
  END IF;
  refs:=ARRAY[]::text[];
  FOR item IN SELECT jsonb_array_elements(value->'holds') LOOP
    IF jsonb_typeof(item)<>'object' OR NOT item ?& ARRAY['domain','id'] OR item-ARRAY['domain','id']<>'{}'::jsonb
      OR jsonb_typeof(item->'domain')<>'string' OR item->>'domain' NOT IN('contact','submission','order','file') OR jsonb_typeof(item->'id')<>'string' THEN RETURN false; END IF;
    key:=(item->>'domain')||':'||((item->>'id')::uuid)::text;
    IF key=ANY(refs) THEN RETURN false; END IF;
    refs:=array_append(refs,key);
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

-- Preserve the previous policy validator verbatim, extending its allowed shape.
DO $$
DECLARE predicate text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO predicate FROM pg_constraint
    WHERE conrelid='crm_privacy_policies'::regclass AND conname='crm_privacy_policies_policy_check';
  IF predicate IS NULL THEN RAISE EXCEPTION 'Missing prior CRM policy constraint'; END IF;
  predicate:=replace(predicate, '''importSourceErasure''::text]', '''importSourceErasure''::text, ''retention''::text]');
  IF position('''retention''::text]' IN predicate)=0 THEN RAISE EXCEPTION 'Unexpected prior CRM policy shape'; END IF;
  ALTER TABLE crm_privacy_policies DROP CONSTRAINT crm_privacy_policies_policy_check;
  EXECUTE 'ALTER TABLE crm_privacy_policies ADD CONSTRAINT crm_privacy_policies_policy_check CHECK(('||predicate||') AND public.crm_retention_policy_valid(policy->''retention''))';
END;
$$;

CREATE TABLE crm_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_version integer NOT NULL CHECK(policy_version>=0),
  mode text NOT NULL CHECK(mode IN('manual','scheduled')),
  before_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
  summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object' AND pg_column_size(summary)<=65536),
  status text NOT NULL CHECK(status IN('ready','blocked','completed','failed')),
  receipt jsonb CHECK(receipt IS NULL OR (jsonb_typeof(receipt)='object' AND pg_column_size(receipt)<=65536)),
  error_code text CHECK(error_code IS NULL OR error_code IN('retention_failed','retention_policy_unavailable','retention_blocked')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id),
  CHECK(expires_at>captured_at),
  CHECK((status='completed')=(receipt IS NOT NULL)),
  CHECK((status='completed')=(completed_at IS NOT NULL)),
  CHECK((status='failed')=(error_code IS NOT NULL)),
  CHECK(mode<>'scheduled' OR status<>'ready')
);
CREATE INDEX crm_retention_runs_recent ON crm_retention_runs(workspace_id,mode,created_at DESC,id DESC);
ALTER TABLE crm_retention_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_retention_runs_owner_read ON crm_retention_runs FOR SELECT USING(
  workspace_id IN(SELECT workspace_id FROM workspace_members
    WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN('owner','admin')));
CREATE FUNCTION public.crm_retention_run_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status<>'ready' OR NEW.status<>'completed'
    OR (to_jsonb(NEW)-ARRAY['status','receipt','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','receipt','completed_at'])
  THEN RAISE EXCEPTION 'CRM retention reviews are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_retention_run_no_edit BEFORE UPDATE ON crm_retention_runs FOR EACH ROW EXECUTE FUNCTION public.crm_retention_run_immutable();
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON crm_retention_runs
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write();
COMMIT;
