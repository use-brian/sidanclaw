-- Workspace module lifecycle is separate from navigation and tool authority.
-- Spec: docs/architecture/features/association-operations.md
BEGIN;

CREATE TABLE workspace_modules (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL CHECK (module_key IN ('association')),
  state TEXT NOT NULL DEFAULT 'disabled' CHECK (state IN ('enabled','draining','disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled_at TIMESTAMPTZ,
  disable_requested_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, module_key)
);

-- Backfill ALL old workspaces; unused integrations are still integrations.
-- There is no human action/audit to invent here.
INSERT INTO workspace_modules (workspace_id,module_key,state,enabled_at)
SELECT id,'association','enabled',now() FROM workspaces;

CREATE FUNCTION public.provision_workspace_modules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.workspace_modules (workspace_id,module_key,state,disabled_at)
  VALUES (NEW.id,'association','disabled',now());
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.provision_workspace_modules() FROM PUBLIC;
CREATE TRIGGER workspaces_provision_modules AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION public.provision_workspace_modules();

ALTER TABLE workspace_modules ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_modules_member_read ON workspace_modules FOR SELECT
USING (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id = current_setting('app.current_user_id',true)::uuid));
CREATE POLICY workspace_modules_admin_insert ON workspace_modules FOR INSERT
WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id = current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
CREATE POLICY workspace_modules_admin_update ON workspace_modules FOR UPDATE
USING (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id = current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members
  WHERE user_id = current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));

COMMIT;
