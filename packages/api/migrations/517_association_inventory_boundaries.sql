-- Canonical inventory admission and committed workflow boundaries. [COMP:crm/association-inventory]
BEGIN;
ALTER TABLE association_registrations ADD COLUMN historical_import boolean NOT NULL DEFAULT false;
CREATE TABLE association_inventory_boundaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  ticket_id uuid,
  sold_out boolean NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  capacity integer CHECK(capacity IS NULL OR capacity>=0),
  used integer NOT NULL CHECK(used>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT(workspace_id,event_id,ticket_id),
  FOREIGN KEY(workspace_id,event_id) REFERENCES association_events(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,ticket_id) REFERENCES association_ticket_types(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE association_inventory_boundaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY association_inventory_boundaries_member_read ON association_inventory_boundaries FOR SELECT USING(
  workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON association_inventory_boundaries
  FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write();
-- Existing occupancy starts at revision zero without replaying historical events.
INSERT INTO association_inventory_boundaries(workspace_id,event_id,ticket_id,sold_out,capacity,used)
SELECT e.workspace_id,e.id,NULL,count(r.id)>=e.capacity,e.capacity,count(r.id)::int
FROM association_events e LEFT JOIN association_registrations r ON r.workspace_id=e.workspace_id AND r.event_id=e.id
  AND (r.status IN('confirmed','checked_in','registered','attended') OR(r.status='reserved' AND r.reservation_expires_at>statement_timestamp()))
WHERE e.capacity IS NOT NULL GROUP BY e.workspace_id,e.id,e.capacity;
INSERT INTO association_inventory_boundaries(workspace_id,event_id,ticket_id,sold_out,capacity,used)
SELECT t.workspace_id,t.event_id,t.id,count(r.id)>=t.capacity,t.capacity,count(r.id)::int
FROM association_ticket_types t LEFT JOIN association_registrations r ON r.workspace_id=t.workspace_id AND r.ticket_id=t.id
  AND (r.status IN('confirmed','checked_in','registered','attended') OR(r.status='reserved' AND r.reservation_expires_at>statement_timestamp()))
WHERE t.capacity IS NOT NULL GROUP BY t.workspace_id,t.event_id,t.id,t.capacity;
ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT crm_domain_event_outbox_event_type_check;
ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_event_type_check CHECK(event_type IN(
  'crm.submission.received','crm.submission.updated','crm.consent.changed','crm.suppression.changed','crm.entitlement.changed',
  'crm.participation.changed','crm.deal.stage_changed','association.inventory.sold_out','association.inventory.available'));
ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT crm_domain_event_outbox_subject_kind_check;
ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_subject_kind_check
  CHECK(subject_kind IN('submission','contact','entitlement','participation','deal','event','ticket'));

CREATE FUNCTION public.association_registration_inventory_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE controlled boolean; ended boolean; reviewer uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.workspace_id,NEW.event_id,NEW.ticket_id,NEW.order_id,NEW.order_line_id,NEW.source_kind,NEW.source_id,NEW.historical_import)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.event_id,OLD.ticket_id,OLD.order_id,OLD.order_line_id,OLD.source_kind,OLD.source_id,OLD.historical_import)
    THEN RAISE EXCEPTION 'Registration source identity is immutable' USING ERRCODE='23514'; END IF;
    IF NEW.source_kind<>'commerce' AND NEW.status NOT IN('registered','attended','cancelled','no_show') THEN
      RAISE EXCEPTION 'Non-commerce participation cannot acquire commerce status' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_kind='commerce' THEN
    IF NEW.historical_import THEN RAISE EXCEPTION 'Commerce registration is not historical import' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN('registered','attended','cancelled','no_show') THEN
    RAISE EXCEPTION 'Non-commerce participation cannot create a commerce reservation' USING ERRCODE='23514';
  END IF;
  -- Catalog changes also lock this event before creating a ticket.
  SELECT capacity IS NOT NULL,ends_at<=clock_timestamp() INTO controlled,ended
    FROM association_events WHERE workspace_id=NEW.workspace_id AND id=NEW.event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Participation event unavailable' USING ERRCODE='23503'; END IF;
  controlled:=controlled OR EXISTS(SELECT 1 FROM association_ticket_types WHERE workspace_id=NEW.workspace_id AND event_id=NEW.event_id);
  IF NEW.historical_import THEN
    reviewer:=NULLIF(current_setting('app.crm_historical_actor',true),'')::uuid;
    IF NEW.source_kind<>'import' OR NOT ended OR reviewer IS NULL OR NOT EXISTS(
      SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=reviewer AND role IN('owner','admin')) THEN
      RAISE EXCEPTION 'Historical participation requires an admin and an ended event' USING ERRCODE='23514';
    END IF;
  ELSIF controlled THEN
    RAISE EXCEPTION 'Controlled event admission requires an Association order' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER association_registration_inventory_guard BEFORE INSERT OR UPDATE ON association_registrations
  FOR EACH ROW EXECUTE FUNCTION public.association_registration_inventory_guard();
COMMIT;
