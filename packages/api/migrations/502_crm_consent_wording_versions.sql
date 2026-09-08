-- [COMP:crm/operations-store] Immutable default/localized consent wording.
BEGIN;

CREATE FUNCTION crm_wording_locales_valid(default_locale text, wording text, wordings jsonb, hashes jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; value jsonb;
BEGIN
  IF default_locale IS NOT NULL AND default_locale NOT IN ('en','zh','zh-CN','ja') THEN RETURN false; END IF;
  IF jsonb_typeof(wordings) IS DISTINCT FROM 'object' OR jsonb_typeof(hashes) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(wordings)) <> (SELECT count(*) FROM jsonb_object_keys(hashes)) THEN RETURN false; END IF;
  FOR key,value IN SELECT * FROM jsonb_each(wordings) LOOP
    IF key NOT IN ('en','zh','zh-CN','ja') OR jsonb_typeof(value) <> 'string'
      OR length(btrim(value #>> '{}')) NOT BETWEEN 1 AND 20000
      OR NOT (hashes ? key) OR jsonb_typeof(hashes->key) <> 'string'
      OR (hashes->>key) !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  END LOOP;
  IF default_locale IS NOT NULL AND wordings ? default_locale
    AND wordings->>default_locale IS DISTINCT FROM wording THEN RETURN false; END IF;
  RETURN true;
END;
$$;

ALTER TABLE crm_consent_purposes
  ADD COLUMN default_locale text,
  ADD COLUMN locale_wordings jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN locale_wording_hashes jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT crm_consent_purpose_locales_valid
    CHECK (crm_wording_locales_valid(default_locale,wording_snapshot,locale_wordings,locale_wording_hashes));

CREATE TABLE crm_consent_purpose_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose_id uuid NOT NULL,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 100),
  wording_snapshot text NOT NULL CHECK (length(wording_snapshot) BETWEEN 1 AND 20000),
  wording_hash text NOT NULL CHECK (wording_hash ~ '^[0-9a-f]{64}$'),
  default_locale text,
  locale_wordings jsonb NOT NULL DEFAULT '{}',
  locale_wording_hashes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,purpose_id,version),
  UNIQUE (workspace_id,purpose_id,id),
  FOREIGN KEY (workspace_id,purpose_id) REFERENCES crm_consent_purposes(workspace_id,id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CHECK (crm_wording_locales_valid(default_locale,wording_snapshot,locale_wordings,locale_wording_hashes))
);

INSERT INTO crm_consent_purpose_versions (workspace_id,purpose_id,version,wording_snapshot,wording_hash,created_at)
SELECT workspace_id,id,active_wording_version,wording_snapshot,wording_hash,created_at FROM crm_consent_purposes;

-- The same historical version label may have been overwritten with different
-- text. Preserve every event snapshot; only unambiguous versions get a row.
INSERT INTO crm_consent_purpose_versions (workspace_id,purpose_id,version,wording_snapshot,wording_hash,created_at)
SELECT workspace_id,purpose_id,wording_version,min(wording_snapshot),min(wording_hash),min(created_at)
FROM association_consent_events
WHERE purpose_id IS NOT NULL AND wording_hash IS NOT NULL AND length(wording_snapshot) BETWEEN 1 AND 20000
GROUP BY workspace_id,purpose_id,wording_version
HAVING count(DISTINCT jsonb_build_array(wording_snapshot,wording_hash))=1
ON CONFLICT (workspace_id,purpose_id,version) DO NOTHING;

-- Drain backfill FK events before later ALTER TABLE / RLS DDL. Empty fresh
-- installs do not expose this; populated upgrades do.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE crm_consent_purposes ADD CONSTRAINT crm_consent_purpose_active_version_fk
  FOREIGN KEY (workspace_id,id,active_wording_version)
  REFERENCES crm_consent_purpose_versions(workspace_id,purpose_id,version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION crm_freeze_purpose_wording() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved crm_consent_purpose_versions%ROWTYPE;
BEGIN
  INSERT INTO crm_consent_purpose_versions
    (workspace_id,purpose_id,version,wording_snapshot,wording_hash,default_locale,locale_wordings,locale_wording_hashes)
  VALUES (NEW.workspace_id,NEW.id,NEW.active_wording_version,NEW.wording_snapshot,NEW.wording_hash,
    NEW.default_locale,NEW.locale_wordings,NEW.locale_wording_hashes)
  ON CONFLICT (workspace_id,purpose_id,version) DO NOTHING;
  SELECT * INTO saved FROM crm_consent_purpose_versions
    WHERE workspace_id=NEW.workspace_id AND purpose_id=NEW.id AND version=NEW.active_wording_version;
  IF (saved.wording_snapshot,saved.wording_hash,saved.default_locale,saved.locale_wordings,saved.locale_wording_hashes)
    IS DISTINCT FROM (NEW.wording_snapshot,NEW.wording_hash,NEW.default_locale,NEW.locale_wordings,NEW.locale_wording_hashes) THEN
    RAISE EXCEPTION 'Consent wording version is immutable' USING ERRCODE='23514',CONSTRAINT='crm_consent_wording_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_consent_purpose_freeze BEFORE INSERT OR UPDATE ON crm_consent_purposes
  FOR EACH ROW EXECUTE FUNCTION crm_freeze_purpose_wording();

CREATE FUNCTION crm_refuse_wording_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Consent wording version is immutable' USING ERRCODE='23514',CONSTRAINT='crm_consent_wording_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_consent_version_immutable BEFORE UPDATE ON crm_consent_purpose_versions
  FOR EACH ROW EXECUTE FUNCTION crm_refuse_wording_version_update();

ALTER TABLE association_consent_events
  ADD COLUMN wording_version_id uuid,
  ADD COLUMN wording_locale text CHECK (wording_locale IS NULL OR wording_locale IN ('en','zh','zh-CN','ja')),
  ADD CONSTRAINT crm_consent_event_version_fk FOREIGN KEY (workspace_id,purpose_id,wording_version_id)
    REFERENCES crm_consent_purpose_versions(workspace_id,purpose_id,id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT crm_consent_event_version_has_purpose CHECK (wording_version_id IS NULL OR purpose_id IS NOT NULL);
UPDATE association_consent_events e SET wording_version_id=v.id
FROM crm_consent_purpose_versions v
WHERE e.workspace_id=v.workspace_id AND e.purpose_id=v.purpose_id AND e.wording_version=v.version
  AND e.wording_hash=v.wording_hash AND e.wording_snapshot=v.wording_snapshot;

SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE crm_consent_purpose_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_consent_versions_member_read ON crm_consent_purpose_versions FOR SELECT
USING (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id=current_setting('app.current_user_id',true)::uuid));
CREATE POLICY crm_consent_versions_admin_write ON crm_consent_purpose_versions FOR ALL
USING (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
CREATE POLICY crm_consent_versions_system ON crm_consent_purpose_versions
USING (COALESCE(current_setting('app.system_bypass',true),'true')='true')
WITH CHECK (COALESCE(current_setting('app.system_bypass',true),'true')='true');

COMMIT;
