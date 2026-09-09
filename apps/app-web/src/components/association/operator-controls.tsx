"use client";

/** Shared native forms, cursor lists and durable request references. [COMP:app-web/association] */
import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useT } from "@/lib/i18n/client";
import { associationPageCacheKey, associationIntentKey } from "@/lib/surface-prefetch";
import { useCachedResource, markSurfaceCacheStale } from "@/lib/surface-cache";
import { listAssociationPage, type AssociationResource, type AssociationListQuery } from "@/lib/api/association";
import { fetchCrmLookup, type CrmLookupRow } from "@/lib/api/crm";
import { requestBrainRefresh } from "@/lib/brain-events";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export function AssociationField({label,value,onChange,multiline=false,...props}:{label:string;value:string;onChange:(value:string)=>void;multiline?:boolean}&Omit<InputHTMLAttributes<HTMLInputElement>,"onChange"|"value">) {
  const className="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base";
  return <label className="flex min-w-0 flex-col gap-1 text-sm">{label}{multiline
    ? <textarea className={className} value={value} onChange={e=>onChange(e.target.value)} disabled={props.disabled} maxLength={props.maxLength} rows={3} />
    : <input {...props} step={props.step ?? (props.type==="datetime-local" ? "0.001" : undefined)} className={className} value={value} onChange={e=>onChange(e.target.value)} />}</label>;
}
export function AssociationChoice({label,value,onChange,values,disabled=false}:{label:string;value:string;onChange:(value:string)=>void;values:readonly string[];disabled?:boolean}) {
  const options=useT().associationPage.manage.options;
  return <label className="flex min-w-0 flex-col gap-1 text-sm">{label}<Select value={value} onValueChange={v=>{if(v)onChange(v);}} disabled={disabled}>
    <SelectTrigger className="min-h-11 w-full" aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent>{values.map(v=><SelectItem value={v} key={v}>{options[v as keyof typeof options]}</SelectItem>)}</SelectContent>
  </Select></label>;
}
export function AssociationToggle({label,checked,onChange,disabled=false}:{label:string;checked:boolean;onChange:(checked:boolean)=>void;disabled?:boolean}) {
  return <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={checked} disabled={disabled} onCheckedChange={v=>onChange(v===true)} />{label}</label>;
}
export function useAssociationPage<K extends AssociationResource>(workspaceId:string,resource:K,query:AssociationListQuery={},enabled=true) {
  const scope=JSON.stringify(query);
  const [position,setPosition]=useState({scope,stack:[undefined] as (string|undefined)[]});
  const stack=position.scope===scope?position.stack:[undefined];
  const cursor=stack.at(-1);
  const read=useCachedResource(enabled?associationPageCacheKey(workspaceId,resource,{...query,cursor}):null,()=>listAssociationPage(workspaceId,resource,{...query,cursor}));
  return {...read,previous:stack.length>1?()=>setPosition({scope,stack:stack.slice(0,-1)}):undefined,
    next:read.data?.nextCursor && !stack.includes(read.data.nextCursor)?()=>setPosition({scope,stack:[...stack,read.data!.nextCursor!]}):undefined};
}
export function AssociationListState({data,error,refresh,previous,next,children}:{data:unknown;error:unknown;refresh:()=>unknown;previous?:()=>void;next?:()=>void;children:ReactNode}) {
  const t=useT().associationPage;
  return <div className="space-y-3">
    {error?<p role="alert" className="text-sm text-destructive">{t.manage.loadFailed}</p>:!data?<ListSurfaceSkeleton rows={3}/>:null}
    {data?children:null}
    <div className="flex flex-wrap gap-2"><Button type="button" className="min-h-11" variant="ghost" onClick={()=>void refresh()}>{t.refresh}</Button>
      {(previous||next)&&<><Button type="button" className="min-h-11" variant="outline" disabled={!previous} onClick={previous}>{t.previous}</Button><Button type="button" className="min-h-11" variant="outline" disabled={!next || !!error} onClick={next}>{t.next}</Button></>}
    </div>
  </div>;
}
export function useAssociationAction(workspaceId:string) {
  const t=useT().associationPage,lock=useRef(false);
  const [pending,setPending]=useState(false),[outcome,setOutcome]=useState<"saved"|"failed"|null>(null);
  async function run(label:string,job:()=>Promise<unknown>) {
    if(lock.current)return false;
    lock.current=true;setPending(true);setOutcome(null);
    try {
      if(!await confirmDialog({title:label,description:t.manage.confirm,confirmLabel:label,cancelLabel:t.cancel}))return false;
      await job();setOutcome("saved");requestBrainRefresh(workspaceId);
      markSurfaceCacheStale(`crm:${workspaceId}:`);markSurfaceCacheStale(`association-orders:${workspaceId}`);markSurfaceCacheStale(`association-module:${workspaceId}`);
      return true;
    } catch {setOutcome("failed");return false;}
    finally {lock.current=false;setPending(false);}
  }
  return {pending,run,feedback:outcome?<p role={outcome==="failed"?"alert":"status"} className={`text-sm ${outcome==="failed"?"text-destructive":"text-muted-foreground"}`}>{t.manage[outcome]}</p>:null};
}
export function useAssociationIntent(workspaceId:string,operation:string,target:string) {
  const t=useT().associationPage;
  const key=associationIntentKey(workspaceId,operation,target);
  const [stored,setStored]=useState<{key:string;id:string}|null>(null);
  useEffect(()=>{try {setStored({key,id:sessionStorage.getItem(key) ?? ""});}catch{setStored(null);}},[key]);
  function identity() {
    const current=sessionStorage.getItem(key) ?? crypto.randomUUID();
    if(!/^[a-f0-9-]{36}$/i.test(current))throw new Error("Invalid request identity");
    sessionStorage.setItem(key,current);setStored({key,id:current});return current;
  }
  async function reset() {
    if(!await confirmDialog({title:t.manage.newRequest,description:t.manage.newRequestHelp,confirmLabel:t.manage.newRequest,cancelLabel:t.cancel}))return;
    try {sessionStorage.removeItem(key);setStored({key,id:""});}catch{/* The retained identity remains authoritative. */}
  }
  return {identity,reference:stored?.key===key?stored.id:"",reset};
}
export function AssociationContactPicker({workspaceId,onSelect}:{workspaceId:string;onSelect:(row:CrmLookupRow)=>void}) {
  const t=useT().associationPage.manage;
  const [draft,setDraft]=useState(""),[query,setQuery]=useState("");
  const data=useCachedResource(associationPageCacheKey(workspaceId,"contact-lookup",{query}),()=>fetchCrmLookup(workspaceId,"contact",query,50));
  return <div className="space-y-2"><AssociationField label={t.contactSearch} value={draft} onChange={setDraft} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();setQuery(draft);}}}/>
    <Button type="button" variant="outline" className="min-h-11" onClick={()=>setQuery(draft)}>{t.contactSearch}</Button>
    {data.error?<p role="alert" className="text-sm text-destructive">{t.loadFailed}</p>:null}
    {!data.data&&!data.error?<ListSurfaceSkeleton rows={2}/>:null}
    <div className="max-h-48 overflow-y-auto divide-y divide-border rounded-lg border border-border">{data.data?.map(row=><button key={row.id} type="button" className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 px-3 text-left text-sm hover:bg-accent" disabled={!!data.error} onClick={()=>onSelect(row)}><span>{row.name}</span><span className="text-muted-foreground">{row.hint}</span></button>)}{data.data?.length===0?<p className="p-3 text-sm">{t.empty}</p>:null}</div>
  </div>;
}
export function AssociationIntentNotice({reference,onReset,disabled}:{reference:string;onReset:()=>unknown;disabled:boolean}) {
  const t=useT().associationPage.manage;
  return reference?<div className="space-y-1 rounded-lg bg-muted p-3 text-sm"><p className="break-all">{t.requestReference}: {reference}</p><Button type="button" className="min-h-11" variant="outline" disabled={disabled} onClick={()=>void onReset()}>{t.newRequest}</Button></div>:null;
}
export function associationLocalTime(instant:string|null|undefined):string {
  if(!instant)return "";
  const date=new Date(instant);return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,23);
}
export function associationInstant(value:string):string|null {return value?new Date(value).toISOString():null;}
