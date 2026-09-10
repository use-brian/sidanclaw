-- Explicit waitlist promotion through canonical orders. [COMP:crm/association-waitlist]
BEGIN;
CREATE TABLE association_waitlist_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  order_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_kind text NOT NULL,
  actor_credential_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,promotion_id),
  UNIQUE(workspace_id,order_id),
  FOREIGN KEY(workspace_id,submission_id) REFERENCES association_enquiries(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,ticket_id) REFERENCES association_ticket_types(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,order_id) REFERENCES association_orders(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX association_waitlist_offers_submission ON association_waitlist_offers(workspace_id,submission_id,created_at DESC,id DESC);
ALTER TABLE association_waitlist_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY association_waitlist_offers_member_read ON association_waitlist_offers FOR SELECT USING(
  workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON association_waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write();
CREATE FUNCTION public.association_waitlist_offer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Waitlist offer identity is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER association_waitlist_offer_immutable BEFORE UPDATE ON association_waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION public.association_waitlist_offer_immutable();
COMMIT;
