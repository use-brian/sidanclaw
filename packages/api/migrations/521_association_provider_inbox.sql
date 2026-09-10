-- Durable normalized provider admission. [COMP:crm/provider-inbox]
BEGIN;
CREATE TABLE association_integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 500),
  provider_reference text NOT NULL CHECK(length(provider_reference) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL,
  target_kind text NOT NULL CHECK(target_kind IN('order','entitlement')),
  order_id uuid,
  entitlement_id uuid,
  contact_id uuid NOT NULL,
  plan_id uuid,
  request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  normalized_payload jsonb NOT NULL CHECK(jsonb_typeof(normalized_payload)='object' AND octet_length(normalized_payload::text)<=32768),
  admitted_actor jsonb NOT NULL CHECK(jsonb_typeof(admitted_actor)='object'),
  execution_actor jsonb NOT NULL CHECK(jsonb_typeof(execution_actor)='object'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','applied','retry','needs_reconciliation')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  cycle_attempts integer NOT NULL DEFAULT 0 CHECK(cycle_attempts BETWEEN 0 AND 8),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK(last_error_code IN('conflict','not_available','invalid_transition','not_authorized','credential_revoked','integration_scope_denied','not_found','idempotency_conflict','invalid_input','transient_failure','processing_failure','attempt_limit','lease_lost')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  UNIQUE(workspace_id,provider,provider_event_id),
  UNIQUE(workspace_id,id),
  CHECK((target_kind='order' AND order_id IS NOT NULL AND plan_id IS NULL AND entitlement_id IS NULL)
    OR (target_kind='entitlement' AND order_id IS NULL AND plan_id IS NOT NULL)),
  CHECK((state='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK(state='processing' OR (lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK((state='applied')=(applied_at IS NOT NULL)),
  FOREIGN KEY(workspace_id,order_id) REFERENCES association_orders(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,entitlement_id) REFERENCES association_memberships(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,contact_id) REFERENCES entities(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,plan_id) REFERENCES association_membership_plans(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX association_integration_events_due ON association_integration_events(state,next_attempt_at,id) WHERE state IN('pending','retry','processing');
CREATE INDEX association_integration_events_order ON association_integration_events(workspace_id,order_id,created_at DESC,id DESC);
ALTER TABLE association_integration_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY association_integration_events_read ON association_integration_events FOR SELECT USING(
  workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON association_integration_events
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write();
CREATE FUNCTION public.association_integration_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='applied' OR ROW(NEW.id,NEW.workspace_id,NEW.provider,NEW.provider_event_id,NEW.provider_reference,NEW.occurred_at,
    NEW.target_kind,NEW.order_id,NEW.contact_id,NEW.plan_id,NEW.request_fingerprint,NEW.normalized_payload,NEW.admitted_actor,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.provider,OLD.provider_event_id,OLD.provider_reference,OLD.occurred_at,
    OLD.target_kind,OLD.order_id,OLD.contact_id,OLD.plan_id,OLD.request_fingerprint,OLD.normalized_payload,OLD.admitted_actor,OLD.created_at)
    OR (OLD.entitlement_id IS NOT NULL AND NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id)
    OR NEW.attempts<OLD.attempts THEN
    RAISE EXCEPTION 'Provider inbox input and applied receipt are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER association_integration_event_immutable BEFORE UPDATE ON association_integration_events
  FOR EACH ROW EXECUTE FUNCTION public.association_integration_event_immutable();
COMMIT;
