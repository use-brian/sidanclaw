-- Per-assistant mini-app switches and named tool sets. Existing app grants
-- remain untouched; historical revocations are never resurrected.
-- Spec: docs/architecture/features/builtin-primitives.md
BEGIN;
WITH grantors AS (
  SELECT a.id, COALESCE(a.owner_user_id,
    (SELECT ac.granted_by_user_id FROM assistant_capabilities ac
     WHERE ac.assistant_id = a.id ORDER BY ac.granted_at LIMIT 1),
    (SELECT wm.user_id FROM workspace_members wm WHERE wm.workspace_id = a.workspace_id
     ORDER BY (wm.role = 'owner') DESC, wm.joined_at LIMIT 1)
  ) AS user_id FROM assistants a
)
INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id, reason)
SELECT a.id, cap.capability, a.user_id, 'mini-app tool sets: preserve existing availability'
FROM grantors a
CROSS JOIN (VALUES ('page'), ('feed'), ('home_app:page:read'), ('home_app:page:write'), ('home_app:office:read'), ('home_app:office:write'), ('home_app:browsers:read'), ('home_app:browsers:write'), ('home_app:tasks:read'), ('home_app:tasks:write'), ('home_app:crm:read'), ('home_app:crm:write'), ('home_app:feed:read'), ('home_app:feed:write')) AS cap(capability)
WHERE a.user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM assistant_capabilities existing
  WHERE existing.assistant_id = a.id AND existing.capability = cap.capability
)
ON CONFLICT (assistant_id, capability) WHERE revoked_at IS NULL DO NOTHING;
COMMIT;
