"use client";

/** Generic CRM membership configuration and complimentary grants. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { grantCrmEntitlement,updateCrmEntitlement,type CrmLookupRow } from "@/lib/api/crm";
import type { AssociationPlan,AssociationMembership } from "@/lib/api/association";
import { crmRecordHref } from "@/lib/crm-view";
import { Button } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { AssociationPlanForm } from "./catalog-forms";
import { AssociationField as Field,AssociationChoice as Choice,AssociationToggle,AssociationContactPicker,AssociationIntentNotice,AssociationListState,useAssociationPage,useAssociationAction,useAssociationIntent,associationLocalTime,associationInstant } from "./operator-controls";

export function AssociationMembershipForm({workspaceId,plan,contact,row,disabled,onSaved}:{workspaceId:string;plan?:AssociationPlan;contact?:CrmLookupRow;row?:AssociationMembership;disabled:boolean;onSaved:()=>void}) {
  const t=useT().associationPage.manage,action=useAssociationAction(workspaceId);
  const intent=useAssociationIntent(workspaceId,"membership",`${plan?.id ?? row?.planId}:${contact?.id ?? row?.contactId}`);
  const [start,setStart]=useState(associationLocalTime(row?.startsAt)),[end,setEnd]=useState(associationLocalTime(row?.endsAt));
  const [status,setStatus]=useState<AssociationMembership["status"]>(row?.status ?? "active"),[renewal,setRenewal]=useState<AssociationMembership["renewalMode"]>(row?.renewalMode ?? "none");
  const unavailable=disabled||!!row?.provider||(!row&&(!plan||!contact||!!plan.provider||Number(plan.feeMinor)!==0));
  return <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={e=>{e.preventDefault();if(unavailable)return;void action.run(row?t.adjust:t.grant,async()=>{
    const changes={status,endsAt:associationInstant(end),renewalMode:renewal};
    if(row) await updateCrmEntitlement(workspaceId,row.id,changes);
    else await grantCrmEntitlement(workspaceId,{contactId:contact!.id,planId:plan!.id,idempotencyKey:intent.identity(),startsAt:associationInstant(start)!,...changes});
    onSaved();
  });}}>
    <h3 className="font-semibold">{row?t.adjust:t.grant}: {contact?.name ?? row?.contactName} / {plan?.name ?? row?.planName}</h3>
    <fieldset disabled={unavailable||action.pending} className="grid gap-3 md:grid-cols-2">
      <Field label={t.start} type="datetime-local" value={start} onChange={setStart} required disabled={!!row}/>
      <Field label={t.end} type="datetime-local" value={end} onChange={setEnd}/>
      <Choice label={t.status} value={status} values={["pending","active","expired","cancelled"]} onChange={v=>setStatus(v as typeof status)}/>
      <Choice label={t.renewal} value={renewal} values={["none","manual","auto"]} onChange={v=>setRenewal(v as typeof renewal)}/>
    </fieldset><p className="text-sm text-muted-foreground">{t.timeHint} {row?t.renewalHelp:t.manualOnly}</p>
    {action.feedback}{!row?<AssociationIntentNotice reference={intent.reference} onReset={intent.reset} disabled={action.pending}/>:null}
    <Button type="submit" className="min-h-11" disabled={unavailable||action.pending}>{row?t.adjust:t.grant}</Button>
  </form>;
}
export function AssociationMembershipsPanel({workspaceId}:{workspaceId:string}) {
  const t=useT().associationPage,plans=useAssociationPage(workspaceId,"plans"),module=useAssociationModule(workspaceId);
  const [contact,setContact]=useState<CrmLookupRow|null>(null),[effectiveOnly,setEffectiveOnly]=useState(false);
  const memberships=useAssociationPage(workspaceId,"memberships",{...(contact?{contactId:contact.id}:{}),activeOnly:effectiveOnly});
  const [editing,setEditing]=useState<AssociationPlan|"new"|null>(null),[grant,setGrant]=useState<AssociationPlan|null>(null),[adjust,setAdjust]=useState<AssociationMembership|null>(null);
  const configure=!!module.data?.canManage&&!module.error;
  return <section className="space-y-6"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{t.manage.plans}</h2><Button type="button" className="min-h-11" variant="outline" disabled={!configure||!!plans.error} onClick={()=>setEditing("new")}>{t.manage.newPlan}</Button></div>
    {!configure?<p className="text-sm text-muted-foreground">{t.manage.canConfigure}</p>:null}
    <AssociationListState {...plans}><div className="divide-y divide-border">{plans.data?.items.map(plan=><div key={plan.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="text-sm"><p className="font-medium">{plan.name}</p><p>{plan.planKey} · {plan.currency} {plan.feeMinor}</p></div>
      <div className="flex flex-wrap gap-2"><Button type="button" className="min-h-11" variant="ghost" disabled={!configure||!!plans.error} onClick={()=>setEditing(plan)}>{t.manage.edit}</Button>
        <Button type="button" className="min-h-11" variant="outline" disabled={!contact||!!plan.provider||Number(plan.feeMinor)!==0||!!plans.error} onClick={()=>{setGrant(plan);setAdjust(null);}}>{t.manage.grant}</Button></div>
    </div>)}</div>{plans.data?.items.length===0?<p>{t.manage.empty}</p>:null}</AssociationListState>
    {editing?<AssociationPlanForm key={editing==="new"?"new":editing.id} workspaceId={workspaceId} plan={editing==="new"?undefined:editing} disabled={!configure||!!plans.error} onSaved={()=>{setEditing(null);void plans.refresh();}}/>:null}
    <h2 className="text-lg font-semibold">{t.manage.memberships}</h2>
    <AssociationContactPicker workspaceId={workspaceId} onSelect={row=>{setContact(row);setGrant(null);setAdjust(null);}}/>
    {contact?<div className="flex flex-wrap items-center gap-3 text-sm"><Link className="inline-flex min-h-11 items-center text-primary" href={crmRecordHref(workspaceId,"contact",contact.id)}>{contact.name}</Link><Button type="button" className="min-h-11" variant="ghost" onClick={()=>{setContact(null);setGrant(null);setAdjust(null);}}>{t.manage.contactClear}</Button></div>:<p className="text-sm text-muted-foreground">{t.manage.contactRequired}</p>}
    {grant&&contact?<AssociationMembershipForm key={`${grant.id}:${contact.id}`} workspaceId={workspaceId} plan={grant} contact={contact} disabled={!!plans.error} onSaved={()=>void memberships.refresh()}/>:null}
    <AssociationToggle label={t.manage.effectiveOnly} checked={effectiveOnly} onChange={setEffectiveOnly}/>
    <AssociationListState {...memberships}><div className="divide-y divide-border">{memberships.data?.items.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="text-sm"><Link className="inline-flex min-h-11 items-center font-medium text-primary" href={crmRecordHref(workspaceId,"contact",row.contactId)}>{row.contactName}</Link><p>{row.planName} · {t.manage.options[row.status]}</p><p>{row.isEffective===undefined?t.manage.unknown:row.isEffective?t.manage.effective:t.manage.ineffective}</p><p className="text-muted-foreground">{new Date(row.startsAt).toLocaleString()} / {row.endsAt?new Date(row.endsAt).toLocaleString():t.manage.unlimited}</p>
        {row.provider?<p>{t.manage.providerManaged}</p>:null}</div>
      <Button type="button" className="min-h-11" variant="outline" disabled={!!row.provider||!!memberships.error} onClick={()=>{setAdjust(row);setGrant(null);}}>{t.manage.adjust}</Button>
    </div>)}</div>{memberships.data?.items.length===0?<p>{t.manage.empty}</p>:null}</AssociationListState>
    {adjust?<AssociationMembershipForm key={adjust.id} workspaceId={workspaceId} row={adjust} disabled={!!memberships.error} onSaved={()=>void memberships.refresh()}/>:null}
  </section>;
}
