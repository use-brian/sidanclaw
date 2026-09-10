-- [COMP:crm/operations-store] Compare provider evidence on both replay paths.
-- Original request bytes for pre-upgrade events are unknown: do not fabricate hashes.
BEGIN;
ALTER TABLE association_consent_events
  ADD COLUMN request_fingerprint TEXT CHECK (request_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE crm_suppression_events
  ADD COLUMN request_fingerprint TEXT CHECK (request_fingerprint ~ '^[0-9a-f]{64}$');
COMMIT;
