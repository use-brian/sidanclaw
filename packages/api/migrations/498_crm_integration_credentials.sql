-- CRM-only integration keys and explicit operation/resource grants.
-- Spec: docs/architecture/features/crm-operations.md
BEGIN;
CREATE TABLE crm_integration_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  secret_prefix TEXT NOT NULL CHECK (secret_prefix ~ '^sk_crm_[a-f0-9-]+$'),
  secret_hash TEXT NOT NULL CHECK (secret_hash LIKE 'scrypt$%'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  UNIQUE (workspace_id,id),
  CHECK (expires_at > created_at)
);
CREATE INDEX crm_integration_credentials_live ON crm_integration_credentials(workspace_id,created_at DESC,id DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE crm_integration_credential_grants (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'crm.records.read','crm.records.write','crm.catalog.read','crm.catalog.configure',
    'crm.submissions.read','crm.submissions.write','crm.consent.read','crm.consent.write',
    'crm.entitlements.read','crm.entitlements.write','crm.participation.read','crm.participation.write',
    'crm.imports.read','crm.imports.write','crm.audit.read','crm.privacy.export','crm.privacy.retention',
    'crm.delivery.read','crm.delivery.dispatch','association.read','association.orders.write',
    'association.provider_events.write')),
  selectors JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(selectors)='object' AND pg_column_size(selectors)<=65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id,operation),
  FOREIGN KEY (workspace_id,credential_id) REFERENCES crm_integration_credentials(workspace_id,id) ON DELETE CASCADE
);

ALTER TABLE crm_integration_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_integration_credential_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_integration_credentials_admin ON crm_integration_credentials
USING (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
CREATE POLICY crm_integration_grants_admin ON crm_integration_credential_grants
USING (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));

-- Rotation creates a new key. An issued key's ceiling cannot change in place.
CREATE FUNCTION public.crm_integration_grants_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'CRM integration grants are immutable; issue a replacement credential';
END;
$$;
CREATE TRIGGER crm_integration_grants_no_update BEFORE UPDATE ON crm_integration_credential_grants
FOR EACH ROW EXECUTE FUNCTION public.crm_integration_grants_immutable();

ALTER TABLE association_audit_log DROP CONSTRAINT association_audit_log_actor_kind_check;
ALTER TABLE association_audit_log ADD CONSTRAINT association_audit_log_actor_kind_check
CHECK (actor_kind IN ('api_key','user','assistant','workflow','brain_key','oauth_token',
  'intake_key','home_app','provider','import','integration_key','system_job'));
ALTER TABLE association_enquiry_notes DROP CONSTRAINT association_enquiry_notes_actor_kind_check;
ALTER TABLE association_enquiry_notes ADD CONSTRAINT association_enquiry_notes_actor_kind_check
CHECK (actor_kind IN ('api_key','user','assistant','workflow','brain_key','oauth_token',
  'intake_key','home_app','provider','import','integration_key','system_job'));
ALTER TABLE association_consent_events DROP CONSTRAINT association_consent_events_actor_kind_check;
ALTER TABLE association_consent_events ADD CONSTRAINT association_consent_events_actor_kind_check
CHECK (actor_kind IS NULL OR actor_kind IN ('user','assistant','workflow','brain_key','oauth_token',
  'intake_key','home_app','provider','import','integration_key','system_job'));
ALTER TABLE crm_suppression_events DROP CONSTRAINT crm_suppression_events_actor_kind_check;
ALTER TABLE crm_suppression_events ADD CONSTRAINT crm_suppression_events_actor_kind_check
CHECK (actor_kind IN ('user','assistant','workflow','brain_key','oauth_token',
  'intake_key','home_app','provider','import','integration_key','system_job'));
ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT crm_domain_event_outbox_actor_kind_check;
ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_actor_kind_check
CHECK (actor_kind IN ('user','assistant','workflow','brain_key','oauth_token',
  'intake_key','home_app','provider','import','integration_key','system_job'));
COMMIT;
