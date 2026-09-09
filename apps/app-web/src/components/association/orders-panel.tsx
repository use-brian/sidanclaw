"use client";

/** Complete history traversal and idempotent order recovery. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { changeAssociationOrder, listAssociationOrders } from "@/lib/api/association";
import { associationOrdersCacheKey } from "@/lib/surface-prefetch";
import { markSurfaceCacheStale, useCachedResource } from "@/lib/surface-cache";
import { crmRecordHref } from "@/lib/crm-view";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export function AssociationOrdersPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage;
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1]!;
  const { data, error, refresh } = useCachedResource(associationOrdersCacheKey(workspaceId, cursor),
    () => listAssociationOrders(workspaceId, cursor ?? undefined));
  const [pending, setPending] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  async function act(orderId: string, action: "cancel" | "confirm-free") {
    if (pending || error) return;
    setPending(orderId);
    try {
      const label = action === "cancel" ? t.cancelOrder : t.confirmFree;
      if (!await confirmDialog({ title: label, description: action === "cancel" ? t.cancelOrderConfirm : t.confirmFreeDescription, confirmLabel: label, cancelLabel: t.cancel })) return;
      setSaveError(false);
      await changeAssociationOrder(workspaceId, orderId, action);
      markSurfaceCacheStale(`association-orders:${workspaceId}`);
      markSurfaceCacheStale(`association-module:${workspaceId}`);
      await refresh();
    } catch { setSaveError(true); await refresh(); }
    finally { setPending(null); }
  }
  return <section className="space-y-3" data-association-orders>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-semibold">{t.orders}</h2>
      <Button className="min-h-11" variant="ghost" disabled={!!pending} onClick={() => void refresh()}>{t.refresh}</Button>
    </div>
    {(error || saveError) && <p role="alert" className="text-sm text-destructive">{saveError ? t.orderSaveFailed : t.ordersLoadFailed}</p>}
    {!data && !error && <ListSurfaceSkeleton rows={5} />}
    {data?.orders.length === 0 && <p className="text-sm text-muted-foreground">{t.noOrders}</p>}
    <div className="divide-y divide-border rounded-xl border border-border">
      {data?.orders.map(order => <article key={order.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <h3 className="break-all font-mono text-sm" title={order.id}>{t.order} {order.id.slice(0, 8)}</h3>
          <p className="text-sm">{t.orderStates[order.status]}</p>
          {order.reservationExpiresAt && order.status === "pending" && <p className="text-xs text-muted-foreground">{t.reservedUntil} {new Date(order.reservationExpiresAt).toLocaleString()}</p>}
          {order.providerReference && <p className="break-all text-xs text-muted-foreground">{t.providerReference}: {order.provider} / {order.providerReference}</p>}
          <Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={crmRecordHref(workspaceId, "contact", order.contactId)}>{t.openContact}</Link>
        </div>
        {order.status === "pending" && <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" variant="outline" disabled={!!pending || !!error} onClick={() => void act(order.id, "cancel")}>{t.cancelOrder}</Button>
          {order.totalMinor === "0" && <Button className="min-h-11" disabled={!!pending || !!error} onClick={() => void act(order.id, "confirm-free")}>{t.confirmFree}</Button>}
        </div>}
      </article>)}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button className="min-h-11" variant="outline" disabled={cursors.length === 1 || !!pending} onClick={() => setCursors(previous => previous.slice(0, -1))}>{t.previous}</Button>
      <Button className="min-h-11" variant="outline" disabled={!data?.nextCursor || !!error || !!pending || cursors.includes(data.nextCursor)} onClick={() => { if (data?.nextCursor) setCursors(previous => [...previous, data.nextCursor]); }}>{t.next}</Button>
    </div>
  </section>;
}
