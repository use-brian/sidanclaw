-- Protected recovery effects, never deleted row content. [COMP:operations/crm-recovery]
BEGIN;
CREATE TABLE public.crm_erasure_journal (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid,
  table_name text NOT NULL,
  operation text NOT NULL CHECK(operation IN('delete','update','insert')),
  row_key jsonb NOT NULL CHECK(jsonb_typeof(row_key)='object'),
  effect jsonb,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((operation='delete')=(effect IS NULL))
);
ALTER TABLE public.crm_erasure_journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_erasure_journal_admin_read ON public.crm_erasure_journal FOR SELECT USING(
  workspace_id IN(SELECT workspace_id FROM public.workspace_members
    WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN('owner','admin')));
CREATE TABLE public.crm_erasure_journal_targets (
  table_name text PRIMARY KEY,
  key_columns text[] NOT NULL,
  capture_inserts boolean NOT NULL
);
ALTER TABLE public.crm_erasure_journal_targets ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.crm_erasure_journal_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Recovery journal is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER crm_erasure_journal_no_edit BEFORE UPDATE OR DELETE ON public.crm_erasure_journal
  FOR EACH ROW EXECUTE FUNCTION public.crm_erasure_journal_immutable();

CREATE FUNCTION public.crm_capture_erasure_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE keys text[]; keep_insert boolean; old_row jsonb; new_row jsonb; key_value jsonb; changed jsonb; ws uuid;
BEGIN
  IF current_setting('app.crm_erasure_capture',true) IS DISTINCT FROM 'on' THEN RETURN NULL; END IF;
  SELECT key_columns,capture_inserts INTO keys,keep_insert FROM public.crm_erasure_journal_targets WHERE table_name=TG_TABLE_NAME;
  IF TG_OP='INSERT' AND NOT keep_insert THEN RETURN NULL; END IF;
  IF keys IS NULL OR cardinality(keys)=0 THEN
    RAISE EXCEPTION 'Recovery capture requires a declared primary key on %',TG_TABLE_NAME USING ERRCODE='23514';
  END IF;
  IF TG_OP<>'INSERT' THEN old_row:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN new_row:=to_jsonb(NEW); END IF;
  SELECT jsonb_object_agg(k,COALESCE(old_row,new_row)->k) INTO key_value FROM unnest(keys) k;
  IF EXISTS(SELECT 1 FROM unnest(keys) k WHERE key_value->k IS NULL OR key_value->k='null'::jsonb) THEN
    RAISE EXCEPTION 'Recovery capture primary key no longer matches the schema' USING ERRCODE='23514';
  END IF;
  ws:=NULLIF(COALESCE(old_row,new_row)->>'workspace_id','')::uuid;
  IF TG_OP='UPDATE' THEN
    IF EXISTS(SELECT 1 FROM unnest(keys) k WHERE old_row->k IS DISTINCT FROM new_row->k) THEN
      RAISE EXCEPTION 'Recovery capture cannot change primary keys' USING ERRCODE='23514';
    END IF;
    SELECT jsonb_object_agg(key,value) INTO changed FROM jsonb_each(new_row)
      WHERE value IS DISTINCT FROM old_row->key AND NOT key=ANY(keys);
    IF changed IS NULL THEN RETURN NULL; END IF;
  ELSIF TG_OP='INSERT' THEN changed:=new_row;
  END IF;
  INSERT INTO public.crm_erasure_journal(workspace_id,table_name,operation,row_key,effect)
    VALUES(ws,TG_TABLE_NAME,lower(TG_OP),key_value,changed);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.crm_capture_erasure_effect() FROM PUBLIC;

CREATE FUNCTION public.crm_install_erasure_capture() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target record; keys text[];
BEGIN
  FOR target IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname NOT IN('crm_erasure_journal','crm_erasure_journal_targets','_migrations')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
  LOOP
    SELECT array_agg(a.attname::text ORDER BY k.ord) INTO keys FROM pg_constraint p,
      unnest(p.conkey) WITH ORDINALITY k(id,ord),pg_attribute a
      WHERE p.conrelid=target.oid AND p.contype='p' AND a.attrelid=target.oid AND a.attnum=k.id;
    INSERT INTO public.crm_erasure_journal_targets VALUES(target.relname,COALESCE(keys,'{}'),target.relname='crm_address_suppression_tombstones')
      ON CONFLICT(table_name) DO UPDATE SET key_columns=EXCLUDED.key_columns,capture_inserts=EXCLUDED.capture_inserts;
    EXECUTE format('DROP TRIGGER IF EXISTS crm_recovery_capture ON public.%I',target.relname);
    EXECUTE format('CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect()',target.relname);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.crm_install_erasure_capture() FROM PUBLIC;
SELECT public.crm_install_erasure_capture();
COMMIT;
