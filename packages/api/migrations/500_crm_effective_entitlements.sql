-- [COMP:crm/operations-pagination] One effective entitlement predicate.
-- Pure evaluation; status is evidence and is never rewritten by a read.
BEGIN;
CREATE FUNCTION crm_entitlement_is_effective(
  lifecycle_status text, starts_at timestamptz, ends_at timestamptz, instant timestamptz
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT coalesce(lifecycle_status = 'active' AND starts_at <= instant
    AND (ends_at IS NULL OR instant < ends_at), false)
$$;
COMMIT;
