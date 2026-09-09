"use client";

/** Complete cursor traversal of safe provider and committed delivery evidence. [COMP:app-web/association] */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { AssociationMailboxPanel } from "./mailbox-panel";
import { AssociationCredentialsPanel } from "./credentials-panel";
import { useT } from "@/lib/i18n/client";
import { AssociationListState,useAssociationPage } from "./operator-controls";

export function AssociationOperationsPanel({workspaceId}:{workspaceId:string}) {
  const module=useAssociationModule(workspaceId),[administration,setAdministration]=useState(false);
  const dictionary=useT(),t=dictionary.associationPage,crm=dictionary.crmPage.operations;
  const receipts=useAssociationPage(workspaceId,"receipts"),audit=useAssociationPage(workspaceId,"audit"),deliveries=useAssociationPage(workspaceId,"deliveries");
  return <section className="space-y-6"><h2 className="text-lg font-semibold">{t.manage.operations}</h2>
    <section className="space-y-3"><h3 className="font-semibold">{t.manage.providerEvidence}</h3><AssociationListState {...receipts}>
      <div className="divide-y divide-border">{receipts.data?.items.map(row=><article key={row.id} className="space-y-1 break-words py-3 text-sm">
        <p>{row.provider} / {row.eventId}</p><p>{t.manage.options[row.state]} · {t.manage.attempts}: {row.attempts}</p>
        {row.orderId?<p>{t.order}: {row.orderId}</p>:null}{row.entitlementId?<p>{t.manage.memberships}: {row.entitlementId}</p>:null}
        {row.errorCode?<p>{t.manage.errorCode}: {row.errorCode}</p>:null}
      </article>)}</div>{receipts.data?.items.length===0?<p>{t.manage.empty}</p>:null}
    </AssociationListState></section>
    <section className="space-y-3"><h3 className="font-semibold">{crm.auditChanges}</h3><AssociationListState {...audit}><div className="divide-y divide-border">
      {audit.data?.items.map(row=><article className="space-y-1 break-words py-3 text-sm" key={row.id}><p>{row.action} · {row.actorKind}</p><p className="text-muted-foreground">{row.id}</p></article>)}
    </div>{audit.data?.items.length===0?<p>{crm.auditEmpty}</p>:null}</AssociationListState></section>
    <section className="space-y-3"><h3 className="font-semibold">{crm.eventDelivery}</h3><AssociationListState {...deliveries}><div className="divide-y divide-border">
      {deliveries.data?.items.map(row=><article className="space-y-1 break-words py-3 text-sm" key={row.id}><p>{row.eventType} · {t.manage.options[row.status]}</p><p>{t.manage.attempts}: {row.attempts}</p><p className="text-muted-foreground">{new Date(row.occurredAt).toLocaleString()} · {row.id}</p></article>)}
    </div>{deliveries.data?.items.length===0?<p>{crm.eventDeliveryEmpty}</p>:null}</AssociationListState></section>
    {module.data?.canManage&&!module.error?<section className="space-y-4"><Button type="button" className="min-h-11" variant="outline" aria-expanded={administration} onClick={()=>setAdministration(value=>!value)}>{t.admin.title}</Button>
      {administration?<><AssociationCredentialsPanel workspaceId={workspaceId} disabled={false}/><AssociationMailboxPanel workspaceId={workspaceId} disabled={false}/></>:null}</section>:null}
  </section>;
}
