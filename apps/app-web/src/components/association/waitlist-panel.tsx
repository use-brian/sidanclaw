"use client";

/** Explicit intake-backed promotion, retaining the request through uncertainty. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { offerAssociationPlace,type AssociationWaitlistRow } from "@/lib/api/association";
import { crmRecordHref } from "@/lib/crm-view";
import { Button } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { AssociationField,AssociationToggle,AssociationListState,AssociationIntentNotice,useAssociationPage,useAssociationIntent,useAssociationAction } from "./operator-controls";

export function AssociationWaitlistOffer({workspaceId,row,enabled}:{workspaceId:string;row:AssociationWaitlistRow;enabled:boolean}) {
  const t=useT().associationPage,action=useAssociationAction(workspaceId),intent=useAssociationIntent(workspaceId,"offer",row.id);
  const [minutes,setMinutes]=useState("20"),[member,setMember]=useState(false),[orderId,setOrderId]=useState<string|null>(null);
  // A retained request may be replayed for its receipt even after module disable.
  const allowed=(enabled&&row.waitlistState==="waiting")||!!intent.reference;
  return <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={e=>{e.preventDefault();if(!allowed)return;void action.run(`${t.manage.offer}: ${row.contactName}`,async()=>{const result=await offerAssociationPlace(workspaceId,row.id,{promotionId:intent.identity(),reservationMinutes:Number(minutes),useMemberPrice:member});setOrderId(result.offer.orderId);});}}>
    <h3 className="font-semibold">{t.manage.offer}: {row.contactName}</h3><fieldset disabled={!allowed||action.pending} className="space-y-3">
      <AssociationField label={t.manage.minutes} type="number" min={1} max={120} required value={minutes} onChange={setMinutes}/>
      <AssociationToggle label={t.manage.memberPricing} checked={member} onChange={setMember}/>
    </fieldset>{action.feedback}<AssociationIntentNotice reference={intent.reference} onReset={intent.reset} disabled={action.pending}/>
    {orderId?<p className="break-all text-sm">{t.order}: {orderId}</p>:null}
    <Button type="submit" className="min-h-11" disabled={!allowed||action.pending}>{t.manage.offer}</Button>
  </form>;
}
export function AssociationWaitlistPanel({workspaceId}:{workspaceId:string}) {
  const t=useT().associationPage,module=useAssociationModule(workspaceId);
  const [includeClosed,setIncludeClosed]=useState(false),[selected,setSelected]=useState<AssociationWaitlistRow|null>(null);
  const rows=useAssociationPage(workspaceId,"waitlist",{includeClosed});
  return <section className="space-y-4"><h2 className="text-lg font-semibold">{t.manage.waitlist}</h2>
    {module.data&&module.data.module.state!=="enabled"?<p className="text-sm text-muted-foreground">{t.stateDescriptions[module.data.module.state]}</p>:null}
    <AssociationToggle label={t.manage.includeClosed} checked={includeClosed} onChange={setIncludeClosed}/>
    <AssociationListState {...rows}><div className="divide-y divide-border">{rows.data?.items.map(row=><div className="flex flex-wrap items-center justify-between gap-3 py-3" key={row.id}>
      <div className="min-w-0 space-y-1 text-sm"><Link className="inline-flex min-h-11 items-center text-primary" href={crmRecordHref(workspaceId,"contact",row.contactId)}>{row.contactName}</Link><p>{t.manage.options[row.waitlistState]}</p><p className="break-all text-xs text-muted-foreground">{row.id}</p>
        {row.orderId?<Link className="inline-flex min-h-11 items-center break-all text-primary" href={`/w/${workspaceId}/association?section=orders`}>{t.order}: {row.orderId}</Link>:null}
        {row.reservationExpiresAt?<p>{t.reservedUntil} {new Date(row.reservationExpiresAt).toLocaleString()}</p>:null}</div>
      <Button type="button" className="min-h-11" variant="outline" disabled={!!rows.error} onClick={()=>setSelected(row)}>{t.manage.offer}</Button>
    </div>)}</div>{rows.data?.items.length===0?<p>{t.manage.empty}</p>:null}</AssociationListState>
    {selected?<AssociationWaitlistOffer key={selected.id} workspaceId={workspaceId} row={rows.data?.items.find(r=>r.id===selected.id) ?? selected} enabled={module.data?.module.state==="enabled"&&!module.error&&!rows.error}/>:null}
  </section>;
}
