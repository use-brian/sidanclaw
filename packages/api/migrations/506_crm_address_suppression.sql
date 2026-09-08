-- Policy-governed suppression survives contact erasure without addresses.
-- [COMP:crm/suppression-tombstones]
BEGIN;
ALTER TABLE crm_privacy_policies DROP CONSTRAINT crm_privacy_policies_policy_check;
ALTER TABLE crm_privacy_policies ADD CONSTRAINT crm_privacy_policies_policy_check CHECK ((
  jsonb_typeof(policy)='object' AND policy ? 'intakeReplay'
  AND policy - ARRAY['intakeReplay','addressSuppression']::text[] = '{}'::jsonb
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
) IS TRUE);
CREATE TABLE crm_address_suppression_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key_version text NOT NULL CHECK (key_version ~ '^[a-zA-Z0-9_-]{1,40}$'),
  address_hmac text NOT NULL CHECK (address_hmac ~ '^[a-f0-9]{64}$'),
  key_check text NOT NULL CHECK (key_check ~ '^[a-f0-9]{64}$'),
  channel text NOT NULL CHECK (channel IN ('email','sms','phone','whatsapp','telegram','slack')),
  purpose_key text,
  reason_code text NOT NULL CHECK (reason_code IN ('consent_withdrawn','manual_do_not_contact','hard_bounce','soft_bounce','complaint','provider_block','legal','invalid_address','other')),
  occurred_at timestamptz NOT NULL,
  policy_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  released_at timestamptz,
  release_evidence_kind text CHECK (release_evidence_kind IN ('consent_event','workspace_file')),
  release_evidence_id uuid,
  FOREIGN KEY (workspace_id,policy_version) REFERENCES crm_privacy_policies(workspace_id,version),
  CHECK ((reason_code='consent_withdrawn') = (purpose_key IS NOT NULL)),
  CHECK ((released_at IS NULL AND release_evidence_kind IS NULL AND release_evidence_id IS NULL)
    OR (released_at IS NOT NULL AND release_evidence_kind IS NOT NULL AND release_evidence_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (workspace_id,key_version,address_hmac,channel,purpose_key,reason_code,occurred_at)
);
CREATE INDEX crm_address_suppression_active ON crm_address_suppression_tombstones(workspace_id,channel,key_version,address_hmac)
  WHERE released_at IS NULL;
ALTER TABLE crm_address_suppression_tombstones ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_address_suppression_admin ON crm_address_suppression_tombstones
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
CREATE FUNCTION crm_address_suppression_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW)-ARRAY['released_at','release_evidence_kind','release_evidence_id']::text[]
      IS DISTINCT FROM to_jsonb(OLD)-ARRAY['released_at','release_evidence_kind','release_evidence_id']::text[]
     OR (OLD.released_at IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Suppression evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_address_suppression_immutable BEFORE UPDATE ON crm_address_suppression_tombstones
  FOR EACH ROW EXECUTE FUNCTION crm_address_suppression_immutable();
COMMIT;
