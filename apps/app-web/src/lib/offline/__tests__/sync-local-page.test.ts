import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FRAGMENT_FIELD, pageToYDocUpdate } from "@use-brian/doc-model";
const state = vi.hoisted(() => ({ saved: null as Uint8Array | null, provider: null as any, persisted: false, closed: false }));
vi.mock("@/lib/auth-fetch", () => ({ getValidAccessToken: vi.fn(async () => "access-token") }));
vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    whenSynced: Promise<void>;
    constructor(_name: string, doc: Y.Doc) {
      this.whenSynced = import("yjs").then((Yjs) => {
        if (state.saved) Yjs.applyUpdate(doc, state.saved);
        state.persisted = true;
      });
    }
    async destroy() { state.closed = true; }
  },
}));
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProviderWebsocket: class {
    async connect() {
      expect(state.persisted).toBe(true);
      expect(state.provider.attached).toBe(true);
      state.provider.isSynced = true;
      state.provider.config.onSynced({ state: true });
    }
    destroy() {}
  },
  HocuspocusProvider: class {
    isSynced = false;
    hasUnsyncedChanges = true;
    attached = false;
    attach() { this.attached = true; }
    constructor(public config: any) { state.provider = this; }
    destroy() {}
  },
}));
import { syncLocalPage } from "../sync-local-page";

beforeEach(() => { state.saved = null; state.provider = null; state.persisted = false; state.closed = false; });
describe("[COMP:app-web/offline-pages] closed-page content replay", () => {
  it("loads offline edits before connecting and waits for their acknowledgement", async () => {
    const seed = pageToYDocUpdate({ blocks: [] }, "New draft");
    const edited = new Y.Doc();
    Y.applyUpdate(edited, seed);
    const paragraph = edited.getXmlFragment(FRAGMENT_FIELD).get(0) as Y.XmlElement;
    const text = new Y.XmlText(); text.insert(0, "Written offline"); paragraph.insert(0, [text]);
    state.saved = Y.encodeStateAsUpdate(edited);
    edited.destroy();
    let done = false;
    const syncing = syncLocalPage("page-a", seed).then(() => { done = true; });
    await vi.waitFor(() => expect(state.provider?.isSynced).toBe(true));
    expect(done).toBe(false); // handshake alone does not acknowledge our edits
    expect(state.provider.config.document.getXmlFragment(FRAGMENT_FIELD).toString()).toContain("Written offline");
    state.provider.hasUnsyncedChanges = false;
    state.provider.config.onUnsyncedChanges({ number: 0 });
    await syncing;
    expect(state.closed).toBe(true);
  });
  it("rejects authentication failure so the outbox retains the page", async () => {
    const syncing = syncLocalPage("page-a", pageToYDocUpdate({ blocks: [] }, "New draft"));
    const rejected = expect(syncing).rejects.toThrow("denied");
    await vi.waitFor(() => expect(state.provider).not.toBeNull());
    state.provider.config.onAuthenticationFailed();
    await rejected;
    expect(state.closed).toBe(true);
  });
});
