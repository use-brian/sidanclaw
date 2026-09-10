-- [COMP:crm/intake-verification] A successful backend attestation travels with its submission.
BEGIN;
ALTER TABLE association_enquiries ADD COLUMN identity_verification_evidence jsonb
  CHECK (identity_verification_evidence IS NULL OR
    (jsonb_typeof(identity_verification_evidence)='object' AND pg_column_size(identity_verification_evidence)<=8192));
COMMIT;
