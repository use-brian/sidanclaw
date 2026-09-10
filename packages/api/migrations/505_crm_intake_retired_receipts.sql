-- Explicit privacy policy and minimized post-erasure intake replay.
-- [COMP:crm/operations-privacy]
BEGIN;
CREATE TABLE crm_privacy_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL CHECK (
    jsonb_typeof(policy)='object' AND policy ? 'intakeReplay'
    AND policy - 'intakeReplay' = '{}'::jsonb
    AND (policy->'intakeReplay' = 'null'::jsonb OR (
      jsonb_typeof(policy->'intakeReplay')='object'
      AND (policy->'intakeReplay') ? 'retentionSeconds'
      AND (policy->'intakeReplay') - 'retentionSeconds' = '{}'::jsonb
      AND jsonb_typeof(policy->'intakeReplay'->'retentionSeconds')='number'
      AND (policy->'intakeReplay'->>'retentionSeconds')::numeric BETWEEN 1 AND 2147483647
      AND trunc((policy->'intakeReplay'->>'retentionSeconds')::numeric)
        = (policy->'intakeReplay'->>'retentionSeconds')::numeric
    ))
  ),
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,version)
);
ALTER TABLE crm_privacy_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_privacy_policies_admin ON crm_privacy_policies
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
CREATE FUNCTION crm_privacy_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Account deletion may clear attribution without rewriting the policy.
  IF NEW.approved_by_user_id IS NULL AND
    to_jsonb(NEW)-'approved_by_user_id' = to_jsonb(OLD)-'approved_by_user_id' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CRM privacy policy versions are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER crm_privacy_policy_immutable BEFORE UPDATE ON crm_privacy_policies
  FOR EACH ROW EXECUTE FUNCTION crm_privacy_policy_immutable();

ALTER TABLE crm_intake_idempotency
  ADD COLUMN replay_policy_version integer,
  ADD COLUMN replay_expires_at timestamptz,
  ADD COLUMN retired_at timestamptz,
  DROP CONSTRAINT crm_intake_idempotency_status_check,
  DROP CONSTRAINT crm_intake_idempotency_check,
  DROP CONSTRAINT crm_intake_idempotency_workspace_id_submission_id_fkey,
  DROP CONSTRAINT crm_intake_idempotency_workspace_id_contact_id_fkey,
  ADD CONSTRAINT crm_intake_replay_policy_fk FOREIGN KEY (workspace_id,replay_policy_version)
    REFERENCES crm_privacy_policies(workspace_id,version),
  ADD CONSTRAINT crm_intake_submission_live_fk FOREIGN KEY (workspace_id,submission_id)
    REFERENCES association_enquiries(workspace_id,id),
  ADD CONSTRAINT crm_intake_contact_live_fk FOREIGN KEY (workspace_id,contact_id)
    REFERENCES entities(workspace_id,id),
  ADD CONSTRAINT crm_intake_replay_horizon_check CHECK (
    (replay_policy_version IS NULL AND replay_expires_at IS NULL) OR
    (replay_policy_version IS NOT NULL AND replay_expires_at IS NOT NULL AND replay_expires_at > created_at)),
  ADD CONSTRAINT crm_intake_receipt_state_check CHECK (
    (status='pending' AND submission_id IS NULL AND contact_id IS NULL
      AND follow_up_task_id IS NULL AND committed_at IS NULL AND retired_at IS NULL) OR
    (status='committed' AND submission_id IS NOT NULL AND contact_id IS NOT NULL
      AND committed_at IS NOT NULL AND retired_at IS NULL) OR
    (status='retired' AND submission_id IS NULL AND contact_id IS NULL
      AND follow_up_task_id IS NULL AND committed_at IS NOT NULL
      AND retired_at IS NOT NULL AND replay_expires_at IS NOT NULL)
  );
CREATE INDEX crm_intake_retired_expiry ON crm_intake_idempotency(workspace_id,replay_expires_at,id)
  WHERE status='retired';
COMMIT;
