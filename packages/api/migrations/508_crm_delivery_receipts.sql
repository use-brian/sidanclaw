-- Durable, single-attempt CRM email records. [COMP:crm/delivery-receipts]
BEGIN;
CREATE TABLE crm_mailbox_integration_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL,
  connector_instance_id uuid NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK(version>0),
  enabled boolean NOT NULL,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(workspace_id,credential_id) REFERENCES crm_integration_credentials(workspace_id,id) ON DELETE CASCADE,
  UNIQUE(workspace_id,credential_id,connector_instance_id)
);
CREATE TABLE crm_delivery_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  connector_instance_id uuid NOT NULL,
  provider_key text NOT NULL,
  purpose_key text NOT NULL,
  actor_kind text NOT NULL,
  actor_credential_id text NOT NULL,
  acting_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  envelope jsonb,
  status text NOT NULL CHECK(status IN('pending','dispatching','sent','blocked','failed','needs_reconciliation')),
  claim_token uuid NOT NULL,
  claim_deadline timestamptz NOT NULL,
  provider_receipt jsonb,
  error_code text,
  accepted_at timestamptz,
  confirmed_at timestamptz,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,delivery_id),
  CHECK(envelope IS NULL OR jsonb_typeof(envelope)='object'),
  CHECK(redacted_at IS NULL OR (envelope IS NULL AND provider_receipt IS NULL)),
  CHECK(confirmed_at IS NULL OR accepted_at IS NOT NULL),
  CHECK((status='sent')=(accepted_at IS NOT NULL)),
  CHECK(provider_receipt IS NULL OR jsonb_typeof(provider_receipt)='object')
);
-- Receipt evidence outlives removal of a connector or its sending credential.
CREATE INDEX crm_delivery_claims_due ON crm_delivery_receipts(claim_deadline,workspace_id,delivery_id) WHERE status='dispatching';
CREATE TABLE crm_delivery_receipt_contacts (
  workspace_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY(workspace_id,delivery_id,contact_id),
  FOREIGN KEY(workspace_id,delivery_id) REFERENCES crm_delivery_receipts(workspace_id,delivery_id) ON DELETE CASCADE
);
ALTER TABLE crm_mailbox_integration_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_delivery_receipt_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_mailbox_integration_grants_admin ON crm_mailbox_integration_grants
  USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN('owner','admin')))
  WITH CHECK(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN('owner','admin')));
CREATE POLICY crm_delivery_receipts_member ON crm_delivery_receipts FOR SELECT
  USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));
CREATE POLICY crm_delivery_receipt_contacts_member ON crm_delivery_receipt_contacts FOR SELECT
  USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));
CREATE FUNCTION protect_crm_delivery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.workspace_id,NEW.delivery_id,NEW.request_hash,NEW.connector_instance_id,NEW.provider_key,NEW.purpose_key,
      NEW.actor_kind,NEW.actor_credential_id,NEW.claim_token,NEW.claim_deadline,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.delivery_id,OLD.request_hash,OLD.connector_instance_id,OLD.provider_key,OLD.purpose_key,
      OLD.actor_kind,OLD.actor_credential_id,OLD.claim_token,OLD.claim_deadline,OLD.created_at)
    OR (NEW.envelope IS DISTINCT FROM OLD.envelope AND NOT(NEW.envelope IS NULL AND NEW.redacted_at IS NOT NULL))
    OR (OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at)
    OR (NEW.status IS DISTINCT FROM OLD.status AND (OLD.status<>'dispatching' OR NEW.status='pending'))
    OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
    OR (NEW.acting_user_id IS DISTINCT FROM OLD.acting_user_id AND NEW.acting_user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'CRM delivery identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_delivery_identity_immutable BEFORE UPDATE ON crm_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_crm_delivery_identity();
COMMIT;
