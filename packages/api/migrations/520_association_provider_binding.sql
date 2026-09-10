-- Provider object admission and immutable normalized domain evidence. [COMP:crm/association-provider]
BEGIN;
CREATE UNIQUE INDEX association_orders_provider_object ON association_orders(workspace_id,provider,provider_reference)
  WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;
CREATE FUNCTION public.association_provider_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_reference IS NOT NULL AND (NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.total_minor IS DISTINCT FROM OLD.total_minor) THEN
    RAISE EXCEPTION 'Bound provider identity and order money are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER association_provider_binding_immutable BEFORE UPDATE ON association_orders
  FOR EACH ROW EXECUTE FUNCTION public.association_provider_binding_immutable();
ALTER TABLE association_provider_events ADD COLUMN request_fingerprint text CHECK(request_fingerprint ~ '^[0-9a-f]{64}$');
CREATE FUNCTION public.association_provider_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Provider evidence is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER association_provider_evidence_immutable BEFORE UPDATE ON association_provider_events
  FOR EACH ROW EXECUTE FUNCTION public.association_provider_evidence_immutable();
COMMIT;
