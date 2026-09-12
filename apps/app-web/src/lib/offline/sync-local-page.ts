/** Upload a closed local page through the same authenticated Yjs protocol.
 * [COMP:app-web/offline-pages]
 */
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { getValidAccessToken } from "@/lib/auth-fetch";
import { DRAWING_PROTOCOL } from '@use-brian/doc-model';

export function resolveSyncUrl(): string {
  const configuredSyncUrl = publicRuntimeConfig().docSyncUrl;
  if (configuredSyncUrl) return configuredSyncUrl;
  if (typeof window !== "undefined" && window.location.hostname === "app.usebrian.ai") {
    return "wss://doc-sync.usebrian.ai";
  }
  return "ws://localhost:8080";
}

export async function syncLocalPage(pageId: string, seed: Uint8Array): Promise<void> {
  const { IndexeddbPersistence } = await import("y-indexeddb");
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(`doc-page-${pageId}`, doc);
  let socket: HocuspocusProviderWebsocket | undefined;
  let provider: HocuspocusProvider | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await persistence.whenSynced;
    Y.applyUpdate(doc, seed);
    socket = new HocuspocusProviderWebsocket({ url: resolveSyncUrl(), autoConnect: false });
    await new Promise<void>((resolve, reject) => {
      const complete = () => {
        if (provider?.isSynced && !provider.hasUnsyncedChanges) resolve();
      };
      provider = new HocuspocusProvider({
        websocketProvider: socket!, name: pageId, document: doc,
        token: async () => DRAWING_PROTOCOL + ((await getValidAccessToken()) ?? ""),
        onSynced: complete,
        onUnsyncedChanges: complete,
        onAuthenticationFailed: () => reject(new Error("offline_page_sync_denied")),
      });
      provider.attach();
      timer = setTimeout(() => reject(new Error("offline_page_sync_timeout")), 15_000);
      void socket!.connect().catch(reject);
    });
  } finally {
    clearTimeout(timer);
    provider?.destroy();
    socket?.destroy();
    await persistence.destroy();
    doc.destroy();
  }
}
