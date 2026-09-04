// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FRAGMENT_FIELD, pageToYDocUpdate } from "@use-brian/doc-model";
const state = vi.hoisted(() => ({ local: null as { seed: Uint8Array; registered: boolean } | null, saved: new Map<string, Uint8Array>(), connect: vi.fn() }));
vi.mock("@/lib/offline/offline-pages", () => ({ LOCAL_PAGES_CHANGED: "local-pages", readLocalPage: async () => state.local }));
vi.mock("@/lib/auth-fetch", () => ({ getValidAccessToken: async () => "token" }));
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProviderWebsocket: class { connect = state.connect; destroy() {} },
  HocuspocusProvider: class { destroy() {} },
}));
vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    whenSynced: Promise<void>;
    save: () => void;
    constructor(private name: string, private doc: Y.Doc) {
      this.save = () => { state.saved.set(name, Y.encodeStateAsUpdate(doc)); };
      this.whenSynced = Promise.resolve().then(() => {
        const saved = state.saved.get(name);
        if (saved) Y.applyUpdate(doc, saved);
        doc.on("update", this.save);
      });
    }
    async destroy() { this.doc.off("update", this.save); }
  },
}));
import { useCollabProvider, type CollabHandle } from "../use-collab-provider";
let latest: CollabHandle;
let root: Root | null;
function Probe() { latest = useCollabProvider("page-a"); return null; }
async function mount() {
  root = createRoot(document.createElement("div"));
  await act(async () => { root!.render(createElement(Probe)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.local = null; state.saved.clear(); state.connect.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; });
describe("[COMP:app-web/collab-provider] offline page lifecycle", () => {
  it("opens a new blank local page, persists edits across navigation, then connects after registration", async () => {
    state.local = { registered: false, seed: pageToYDocUpdate({ blocks: [] }, "New draft") };
    await mount();
    expect(latest.synced).toBe(true);
    expect(state.connect).not.toHaveBeenCalled();
    const paragraph = latest.doc!.getXmlFragment(FRAGMENT_FIELD).get(0) as Y.XmlElement;
    paragraph.insert(0, [new Y.XmlText("Local edits survive")]);
    await act(async () => root!.unmount()); root = null;
    await mount();
    expect(latest.doc!.getXmlFragment(FRAGMENT_FIELD).toString()).toContain("Local edits survive");
    state.local.registered = true;
    await act(async () => { window.dispatchEvent(new Event("local-pages")); });
    expect(state.connect).toHaveBeenCalledTimes(1);
  });
  it("keeps an uncached server page gated until it actually loads content", async () => {
    await mount();
    expect(latest.synced).toBe(false);
    expect(state.connect).toHaveBeenCalledTimes(1);
  });
});
