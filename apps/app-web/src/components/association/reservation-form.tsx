"use client";

/** Stable reservation requests over canonical inventory commands. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { reserveAssociationOrder,type AssociationTicket } from "@/lib/api/association";
import { crmRecordHref } from "@/lib/crm-view";
import type { CrmLookupRow } from "@/lib/api/crm";
import { Button } from "@/components/ui/button";
import { AssociationContactPicker,AssociationField,AssociationToggle,AssociationIntentNotice,useAssociationAction,useAssociationIntent } from "./operator-controls";

type Attendee={key:string;name:string;email:string;contactId?:string};
export function AssociationReservationForm({workspaceId,ticket,disabled}:{workspaceId:string;ticket:AssociationTicket;disabled:boolean}) {
  const t=useT().associationPage,action=useAssociationAction(workspaceId);
  const intent=useAssociationIntent(workspaceId,"reserve",ticket.id);
  const unavailable=disabled&&!intent.reference;
  const [buyer,setBuyer]=useState<CrmLookupRow|null>(null),[minutes,setMinutes]=useState("20"),[member,setMember]=useState(false);
  const [attendees,setAttendees]=useState<Attendee[]>([{key:"first",name:"",email:""}]),[orderId,setOrderId]=useState<string|null>(null);
  function update(key:string,change:Partial<Attendee>) {setAttendees(rows=>rows.map(row=>row.key===key?{...row,...change}:row));}
  return <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={e=>{e.preventDefault();if(unavailable||!buyer)return;void action.run(t.manage.reserve,async()=>{
    const result=await reserveAssociationOrder(workspaceId,{contactId:buyer.id,idempotencyKey:intent.identity(),reservationMinutes:Number(minutes),lines:[{ticketId:ticket.id,quantity:attendees.length,useMemberPrice:member,attendees:attendees.map(({name,email,contactId})=>({name,...(email?{email}:{}),...(contactId?{contactId}:{})}))}]});setOrderId(result.order.id);
  });}}>
    <h3 className="font-semibold">{t.manage.reserve}: {ticket.name}</h3>
    <fieldset disabled={unavailable||action.pending} className="space-y-3">
      <AssociationContactPicker workspaceId={workspaceId} onSelect={setBuyer}/>
      <p className="text-sm">{buyer?`${t.openContact}: ${buyer.name}`:t.manage.contactRequired}</p>
      <AssociationField label={t.manage.minutes} type="number" min={1} max={120} required value={minutes} onChange={setMinutes}/>
      <AssociationToggle label={t.manage.memberPricing} checked={member} onChange={setMember} disabled={ticket.memberPriceMinor===null}/>
      {attendees.map((row,index)=><div key={row.key} className="space-y-3 rounded-lg border border-border p-3" data-association-attendee>
        <h4 className="font-medium">{t.manage.attendees} {index+1}</h4>
        <details><summary className="min-h-11 cursor-pointer py-3 text-sm">{t.manage.contactSearch}</summary><AssociationContactPicker workspaceId={workspaceId} onSelect={contact=>update(row.key,{contactId:contact.id,name:contact.name})}/></details>
        {row.contactId?<Link className="inline-flex min-h-11 items-center text-sm text-primary" href={crmRecordHref(workspaceId,"contact",row.contactId)}>{t.openContact}</Link>:null}
        <AssociationField label={t.manage.attendeeName} value={row.name} onChange={name=>update(row.key,{name})} required maxLength={200}/>
        <AssociationField label={t.manage.attendeeEmail} type="email" value={row.email} onChange={email=>update(row.key,{email})} maxLength={320}/>
        <Button type="button" variant="ghost" className="min-h-11" disabled={attendees.length===1} onClick={()=>setAttendees(rows=>rows.filter(r=>r.key!==row.key))}>{t.manage.remove}</Button>
      </div>)}
      <Button type="button" className="min-h-11" variant="outline" disabled={attendees.length>=ticket.perOrderLimit} onClick={()=>setAttendees(rows=>[...rows,{key:crypto.randomUUID(),name:"",email:""}])}>{t.manage.addAttendee}</Button>
    </fieldset>
    {action.feedback}<AssociationIntentNotice reference={intent.reference} onReset={intent.reset} disabled={action.pending}/>
    {orderId?<p className="break-all text-sm">{t.order}: {orderId} <Link className="inline-flex min-h-11 items-center text-primary" href={`/w/${workspaceId}/association?section=orders`}>{t.history}</Link></p>:null}
    <Button type="submit" className="min-h-11" disabled={!buyer||unavailable||action.pending}>{t.manage.reserve}</Button>
  </form>;
}
