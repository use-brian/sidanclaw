-- Explicit per-workspace/account admission policy. [COMP:crm/delivery-policy]
BEGIN;
CREATE TABLE crm_managed_mailbox_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_instance_id uuid NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  version integer NOT NULL CHECK(version>0),
  managed boolean NOT NULL,
  purpose_keys text[] NOT NULL DEFAULT '{}',
  template_purposes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(template_purposes)='object'),
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (cardinality(purpose_keys)<=200 AND (NOT managed OR cardinality(purpose_keys)>0)),
  UNIQUE (workspace_id,connector_instance_id),
  UNIQUE (workspace_id,provider_key)
);
ALTER TABLE crm_managed_mailbox_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_managed_mailbox_admin ON crm_managed_mailbox_policies
  USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN('owner','admin')))
  WITH CHECK(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN('owner','admin')));

-- FK key-share locks alone do not serialize a withdrawal with dispatch's
-- person share lock. Cover every evidence writer, including imports/intake.
CREATE FUNCTION crm_lock_delivery_evidence_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM entities WHERE workspace_id=NEW.workspace_id AND id=NEW.contact_id FOR UPDATE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_consent_delivery_person_lock BEFORE INSERT ON association_consent_events
  FOR EACH ROW EXECUTE FUNCTION crm_lock_delivery_evidence_person();
CREATE TRIGGER crm_suppression_delivery_person_lock BEFORE INSERT ON crm_suppression_events
  FOR EACH ROW EXECUTE FUNCTION crm_lock_delivery_evidence_person();
COMMIT;
