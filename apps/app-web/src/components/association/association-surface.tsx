"use client";

/** Native workspace Association surface. [COMP:app-web/association] */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { AssociationModuleControls } from "./module-controls";
import { AssociationEventsPanel } from "./events-panel";
import { AssociationMembershipsPanel } from "./memberships-panel";
import { AssociationWaitlistPanel } from "./waitlist-panel";
import { AssociationOperationsPanel } from "./operations-panel";
import { AssociationOrdersPanel } from "./orders-panel";

export function AssociationSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage;
  const search = useSearchParams();
  const tabs = ["overview", "memberships", "events", "orders", "waitlist", "operations"] as const;
  const section = tabs.find(tab => tab === search?.get("section")) ?? "overview";
  return <div className="flex h-full min-h-0 flex-col" data-association-surface>
    <OperatorTopbar app="association" right={<Link className="inline-flex min-h-11 items-center px-3 text-sm text-primary" href={`/w/${workspaceId}/crm`}>{t.openCrm}</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
      <nav className="mb-4 flex flex-wrap gap-2" aria-label={t.name}>
        {tabs.map(tab => <Link key={tab} href={`/w/${workspaceId}/association?section=${tab}`}
          aria-current={section === tab ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm ${section === tab ? "bg-accent font-medium" : "hover:bg-accent/50"}`}>{tab === "overview" || tab === "orders" ? t[tab] : t.manage[tab]}</Link>)}
      </nav>
      {section === "overview" && <AssociationModuleControls workspaceId={workspaceId} />}
      {section === "memberships" && <AssociationMembershipsPanel key={workspaceId} workspaceId={workspaceId} />}
      {section === "events" && <AssociationEventsPanel key={workspaceId} workspaceId={workspaceId} />}
      {section === "orders" && <AssociationOrdersPanel key={workspaceId} workspaceId={workspaceId} />}
      {section === "waitlist" && <AssociationWaitlistPanel key={workspaceId} workspaceId={workspaceId} />}
      {section === "operations" && <AssociationOperationsPanel key={workspaceId} workspaceId={workspaceId} />}
    </div>
  </div>;
}
