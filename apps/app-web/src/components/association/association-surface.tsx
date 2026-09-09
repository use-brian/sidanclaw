"use client";

/** Native workspace Association surface. [COMP:app-web/association] */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { AssociationModuleControls } from "./module-controls";
import { AssociationOrdersPanel } from "./orders-panel";

export function AssociationSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage;
  const search = useSearchParams();
  const section = search?.get("section") === "orders" ? "orders" : "overview";
  return <div className="flex h-full min-h-0 flex-col" data-association-surface>
    <OperatorTopbar app="association" right={<Link className="inline-flex min-h-11 items-center px-3 text-sm text-primary" href={`/w/${workspaceId}/crm`}>{t.openCrm}</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
      <nav className="mb-4 flex flex-wrap gap-2" aria-label={t.name}>
        {(["overview", "orders"] as const).map(tab => <Link key={tab} href={`/w/${workspaceId}/association?section=${tab}`}
          aria-current={section === tab ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm ${section === tab ? "bg-accent font-medium" : "hover:bg-accent/50"}`}>{t[tab]}</Link>)}
      </nav>
      {section === "overview" ? <AssociationModuleControls workspaceId={workspaceId} /> : <AssociationOrdersPanel key={workspaceId} workspaceId={workspaceId} />}
    </div>
  </div>;
}
