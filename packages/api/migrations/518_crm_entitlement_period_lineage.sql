-- Canonical provider period lineage. [COMP:crm/entitlement-periods]
BEGIN;
ALTER TABLE association_memberships
  ADD COLUMN provider_period_id text CHECK(provider_period_id IS NULL OR length(provider_period_id) BETWEEN 1 AND 500),
  ADD COLUMN predecessor_id uuid,
  ADD CONSTRAINT association_memberships_period_requires_provider CHECK(provider_period_id IS NULL OR (provider IS NOT NULL AND ends_at IS NOT NULL)),
  ADD CONSTRAINT association_memberships_predecessor_requires_period CHECK(predecessor_id IS NULL OR provider_period_id IS NOT NULL),
  ADD CONSTRAINT association_memberships_predecessor_fk FOREIGN KEY(workspace_id,predecessor_id)
    REFERENCES association_memberships(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;
DROP INDEX association_memberships_provider_once;
CREATE UNIQUE INDEX association_memberships_provider_once ON association_memberships(workspace_id,provider,provider_membership_id)
  WHERE provider IS NOT NULL AND provider_period_id IS NULL;
CREATE UNIQUE INDEX association_memberships_period_once ON association_memberships(workspace_id,provider,provider_membership_id,provider_period_id)
  WHERE provider_period_id IS NOT NULL;
CREATE UNIQUE INDEX association_memberships_successor_once ON association_memberships(workspace_id,predecessor_id) WHERE predecessor_id IS NOT NULL;

CREATE FUNCTION public.crm_entitlement_lineage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE previous public.association_memberships; replay public.association_memberships;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.workspace_id,NEW.provider,NEW.provider_membership_id,NEW.provider_period_id,NEW.predecessor_id)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.provider,OLD.provider_membership_id,OLD.provider_period_id,OLD.predecessor_id) THEN
      RAISE EXCEPTION 'Provider entitlement identity is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.status IN('expired','cancelled') AND NEW.status<>OLD.status THEN
      RAISE EXCEPTION 'Terminal entitlement cannot be revived' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.provider IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-provider-period:'||NEW.workspace_id::text||':'||NEW.provider||':'||NEW.provider_membership_id,0));
  SELECT * INTO replay FROM association_memberships WHERE workspace_id=NEW.workspace_id AND provider=NEW.provider
    AND provider_membership_id=NEW.provider_membership_id AND provider_period_id IS NOT DISTINCT FROM NEW.provider_period_id;
  IF FOUND THEN RETURN NEW; END IF; -- Unique indexes + canonical fingerprint check decide replay.
  IF NEW.provider_period_id IS NULL THEN
    IF EXISTS(SELECT 1 FROM association_memberships WHERE workspace_id=NEW.workspace_id AND provider=NEW.provider AND provider_membership_id=NEW.provider_membership_id) THEN
      RAISE EXCEPTION 'Provider renewal requires an explicit period' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.predecessor_id IS NULL THEN
    IF EXISTS(SELECT 1 FROM association_memberships WHERE workspace_id=NEW.workspace_id AND provider=NEW.provider AND provider_membership_id=NEW.provider_membership_id) THEN
      RAISE EXCEPTION 'Provider renewal requires the terminal predecessor' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO previous FROM association_memberships WHERE workspace_id=NEW.workspace_id AND id=NEW.predecessor_id FOR UPDATE;
    IF NOT FOUND OR previous.status NOT IN('expired','cancelled') OR previous.contact_id<>NEW.contact_id
      OR previous.plan_id<>NEW.plan_id OR previous.provider IS DISTINCT FROM NEW.provider
      OR previous.provider_membership_id IS DISTINCT FROM NEW.provider_membership_id
      OR previous.starts_at>=NEW.starts_at OR NEW.predecessor_id=NEW.id THEN
      RAISE EXCEPTION 'Provider renewal predecessor does not match a terminal period' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM association_memberships WHERE workspace_id=NEW.workspace_id AND predecessor_id=NEW.predecessor_id) THEN
      RAISE EXCEPTION 'Provider predecessor already has a successor' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_entitlement_lineage_guard BEFORE INSERT OR UPDATE ON association_memberships
  FOR EACH ROW EXECUTE FUNCTION public.crm_entitlement_lineage_guard();
COMMIT;
