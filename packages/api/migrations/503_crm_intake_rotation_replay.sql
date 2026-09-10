-- [COMP:crm/operations-store] Replacement intake keys retain a backend's replay namespace.
BEGIN;
ALTER TABLE crm_intake_credentials
  ADD COLUMN replay_scope_id uuid,
  ADD COLUMN rotated_from_credential_id uuid,
  ADD CONSTRAINT crm_intake_credential_rotation_fk FOREIGN KEY (workspace_id,rotated_from_credential_id)
    REFERENCES crm_intake_credentials(workspace_id,id) ON DELETE SET NULL (rotated_from_credential_id);
UPDATE crm_intake_credentials SET replay_scope_id=id;
ALTER TABLE crm_intake_credentials ALTER COLUMN replay_scope_id SET NOT NULL;

CREATE FUNCTION crm_intake_credential_replay_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.rotated_from_credential_id IS NULL THEN
      NEW.replay_scope_id := NEW.id;
    ELSE
      SELECT replay_scope_id INTO NEW.replay_scope_id FROM crm_intake_credentials
        WHERE workspace_id=NEW.workspace_id AND id=NEW.rotated_from_credential_id FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Intake rotation source is unavailable'
          USING ERRCODE='23503',CONSTRAINT='crm_intake_credential_rotation_fk';
      END IF;
    END IF;
  ELSIF NEW.replay_scope_id IS DISTINCT FROM OLD.replay_scope_id THEN
    RAISE EXCEPTION 'Intake replay namespace is immutable'
      USING ERRCODE='23514',CONSTRAINT='crm_intake_replay_scope_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_intake_credential_replay_scope BEFORE INSERT OR UPDATE ON crm_intake_credentials
  FOR EACH ROW EXECUTE FUNCTION crm_intake_credential_replay_scope();
COMMIT;
