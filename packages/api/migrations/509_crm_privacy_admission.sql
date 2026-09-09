-- Serialize privacy validation/mutation against CRM copies. [COMP:crm/privacy-admission]
BEGIN;

CREATE FUNCTION public.crm_privacy_guard_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  previous_workspace uuid;
  next_workspace uuid;
  selected_workspace uuid;
  canonical_workspace uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN previous_workspace:=OLD.workspace_id; END IF;
  IF TG_OP<>'DELETE' THEN next_workspace:=NEW.workspace_id; END IF;
  -- The generic history sidecar has legacy null-workspace rows. CRM
  -- snapshots are attributable by their live canonical parent and may not
  -- recreate a non-null before-image after that parent was purged.
  IF TG_TABLE_NAME='brain_row_versions' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.primitive NOT IN('entity','contact','company','deal') THEN RETURN NEW; END IF;
    ELSIF TG_OP='DELETE' THEN
      IF OLD.primitive NOT IN('entity','contact','company','deal') THEN RETURN OLD; END IF;
    ELSE
      IF OLD.primitive NOT IN('entity','contact','company','deal')
        AND NEW.primitive NOT IN('entity','contact','company','deal') THEN RETURN NEW; END IF;
    END IF;
    IF TG_OP<>'INSERT' THEN
      IF previous_workspace IS NULL AND OLD.primitive IN('entity','contact','company','deal') THEN
        SELECT workspace_id INTO previous_workspace FROM entities WHERE id=OLD.row_id;
      END IF;
    END IF;
    IF TG_OP<>'DELETE' THEN
      IF NEW.primitive IN('entity','contact','company','deal') THEN
        SELECT workspace_id INTO canonical_workspace FROM entities WHERE id=NEW.row_id;
        IF next_workspace IS NULL THEN next_workspace:=canonical_workspace; END IF;
        IF NEW.before_image IS NOT NULL AND (canonical_workspace IS NULL OR next_workspace<>canonical_workspace) THEN
          RAISE EXCEPTION 'crm_privacy_subject_unavailable' USING ERRCODE='55P03';
        END IF;
      END IF;
    END IF;
  END IF;
  FOR selected_workspace IN
    SELECT DISTINCT w FROM unnest(ARRAY[previous_workspace,next_workspace]) w
    WHERE w IS NOT NULL ORDER BY w
  LOOP
    -- A row may already be locked before this trigger runs. Waiting for the
    -- privacy holder would reverse its advisory -> row order and deadlock.
    IF NOT pg_try_advisory_xact_lock_shared(
      hashtextextended('crm-privacy-admission:'||selected_workspace::text,0)
    ) THEN
      RAISE EXCEPTION 'crm_privacy_operation_busy' USING ERRCODE='55P03';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'association_audit_log',
    'association_consent_events',
    'association_enquiries',
    'association_enquiry_notes',
    'association_events',
    'association_external_identities',
    'association_membership_plans',
    'association_memberships',
    'association_notification_outbox',
    'association_order_lines',
    'association_orders',
    'association_provider_events',
    'association_registrations',
    'association_ticket_types',
    'brain_row_versions',
    'correction_audit',
    'crm_activities',
    'crm_address_suppression_tombstones',
    'crm_consent_purpose_versions',
    'crm_consent_purposes',
    'crm_deal_contacts',
    'crm_delivery_receipt_contacts',
    'crm_delivery_receipts',
    'crm_domain_event_outbox',
    'crm_email_draft_session_anchors',
    'crm_email_draft_versions',
    'crm_email_drafts',
    'crm_entity_separations',
    'crm_field_definitions',
    'crm_identity_bindings',
    'crm_import_chunks',
    'crm_import_errors',
    'crm_import_jobs',
    'crm_import_rows',
    'crm_import_sources',
    'crm_intake_credential_definitions',
    'crm_intake_credentials',
    'crm_intake_definition_versions',
    'crm_intake_definitions',
    'crm_intake_idempotency',
    'crm_integration_credential_grants',
    'crm_integration_credentials',
    'crm_mailbox_integration_grants',
    'crm_managed_mailbox_policies',
    'crm_pipeline_stages',
    'crm_pipelines',
    'crm_privacy_policies',
    'crm_saved_views',
    'crm_segments',
    'crm_suppression_events',
    'decision_applications',
    'decision_derivations',
    'decision_events',
    'entities',
    'entity_external_identities',
    'entity_links',
    'entity_merges',
    'tasks',
    'workspace_audit_log',
    'workspace_files',
    'workspace_modules'
  ] LOOP
    EXECUTE format('CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write()',table_name);
  END LOOP;
END;
$$;

COMMIT;
