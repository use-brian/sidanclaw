// @vitest-environment jsdom
/**
 * [COMP:app-web/office-surface-cache] Office home + editor shell on the ONE
 * surface cache (instant-navigation contract N1 / N2 / N3 / N7).
 *
 * Pins the two behaviours every adopted surface owes: a warmed key paints on
 * the first frame with the fetch still pending (no skeleton, no sentence), and
 * a mark-stale repaints without a blank frame. Plus the editor's own claim:
 * its chrome paints from the home's list row before the snapshot resolves,
 * and the row + snapshot are two parallel keys, never a waterfall.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ search: "" }));
const api = vi.hoisted(() => ({
  listOfficeArtifacts: vi.fn<() => Promise<unknown>>(),
  getOfficeArtifact: vi.fn<() => Promise<unknown>>(),
  getOfficeSnapshot: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn(), push: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }) }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "viewer-1", name: "Viewer", email: "viewer@example.com" }) }));
vi.mock("@/lib/office/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/office/api")>();
  return {
    ...actual,
    listOfficeArtifacts: (...args: unknown[]) => api.listOfficeArtifacts(...(args as [])),
    getOfficeArtifact: (...args: unknown[]) => api.getOfficeArtifact(...(args as [])),
    getOfficeSnapshot: (...args: unknown[]) => api.getOfficeSnapshot(...(args as [])),
    listOfficeComments: vi.fn(async () => []),
    listOfficeSuggestions: vi.fn(async () => []),
    detachMissingOfficeComments: vi.fn(async () => 0),
  };
});
// The editor shell's heavy neighbours: collab, presence, the three editors,
// the recorder and the reclassify dialog are not what this test grades.
vi.mock("@/lib/collab/use-collab-provider", () => ({ useCollabProvider: () => ({ doc: null, provider: null, status: "disconnected", synced: false }) }));
vi.mock("@/lib/collab/use-presence", () => ({ usePresence: () => [], usePublishPresenceActivity: vi.fn(), usePublishPresenceIdentity: vi.fn() }));
vi.mock("@/components/doc/presence-avatars", () => ({ PresenceAvatars: () => null }));
vi.mock("@/components/context/reclassify-context-dialog", () => ({ ReclassifyContextButton: () => <button type="button">Reclassify</button> }));
vi.mock("@/components/chrome/dock-recorder", () => ({ DockRecorderFallback: ({ className }: { className?: string }) => <div data-testid="recorder" className={className} /> }));
vi.mock("@/lib/chat-dock-suppress", () => ({ chatDockSuppression: { suppress: () => () => undefined } }));
vi.mock("../document-editor", () => ({ DocumentEditor: ({ snapshot }: { snapshot: { artifactId: string } }) => <div data-testid="document-editor" data-artifact={snapshot.artifactId} /> }));
vi.mock("../presentation-editor", () => ({ PresentationEditor: () => <div data-testid="presentation-editor" /> }));
vi.mock("../spreadsheet-editor", () => ({ SpreadsheetEditor: () => <div data-testid="spreadsheet-editor" /> }));
vi.mock("../presentation-presenter", () => ({ PresentationPresenter: () => null }));
vi.mock("../job-activity", () => ({ OfficeJobActivity: () => <div data-testid="job-activity" /> }));
vi.mock("../office-card-preview", () => ({ OfficeCardPreview: () => <div data-testid="card-preview" /> }));
vi.mock("@/lib/office/offline", () => ({
  appendOfflineCommand: vi.fn(), classifyOfficeReconnect: vi.fn(), listOfflineJournal: vi.fn(async () => []),
  loadOfflinePackage: vi.fn(async () => null), removeOfflineJournalEntry: vi.fn(), removeOfflinePackage: vi.fn(async () => undefined),
}));

import { OfficeHome } from "../office-home";
import { OfficeEditorShell } from "../office-editor-shell";
import { invalidateSurfaceCache, loadSurfaceCache, markSurfaceCacheStale, readSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { invalidateOfficeList, officeArtifactCacheKey, officeListCacheKey, officeSnapshotCacheKey } from "@/lib/surface-prefetch";
import { officeArtifactFromListCache, useOfficeCacheRevalidation } from "@/lib/office/surface-cache";
import type { OfficeArtifact } from "@/lib/office/api";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ARTIFACT = "22222222-2222-4222-8222-222222222222";
const ROW: OfficeArtifact = { artifactId: ARTIFACT, family: "document", title: "Quarterly plan", version: 3, lifecycleState: "active", role: "edit" };
const SNAPSHOT = { snapshot: { family: "document", artifactId: ARTIFACT, workspaceId: WORKSPACE, sections: [], resources: [] }, seq: 7, baseVersion: 3 };

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const pending = () => new Promise<never>(() => undefined);

let container: HTMLDivElement;
let root: Root;
function render(node: React.ReactNode) {
  act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}>{node}</I18nProvider>));
}

beforeEach(() => {
  resetSurfaceCache();
  navigation.search = "";
  api.listOfficeArtifacts.mockReset();
  api.getOfficeArtifact.mockReset();
  api.getOfficeSnapshot.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("[COMP:app-web/office-surface-cache] Office home", () => {
  it("paints the warmed list on the first frame while the fetch is still pending (N1)", async () => {
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "active"), async () => [ROW]);
    api.listOfficeArtifacts.mockImplementation(pending);
    render(<OfficeHome workspaceId={WORKSPACE} />);
    expect(container.querySelector('[data-office-file-grid="true"]')).not.toBeNull();
    expect(container.textContent).toContain("Quarterly plan");
    expect(container.querySelector("[data-office-home-skeleton]")).toBeNull();
    expect(container.textContent).not.toContain(en.office.loading);
  });

  it("renders the card skeleton, never a sentence, when nothing is cached (N4)", () => {
    api.listOfficeArtifacts.mockImplementation(pending);
    render(<OfficeHome workspaceId={WORKSPACE} />);
    expect(container.querySelector("[data-office-home-skeleton]")).not.toBeNull();
    expect(container.textContent).not.toContain(en.office.loading);
  });

  it("repaints without a blank frame after markSurfaceCacheStale (N3)", async () => {
    const key = officeListCacheKey(WORKSPACE, "active");
    await loadSurfaceCache(key, async () => [ROW]);
    let resolveNext: (rows: OfficeArtifact[]) => void = () => undefined;
    api.listOfficeArtifacts.mockImplementation(() => new Promise<OfficeArtifact[]>((resolve) => { resolveNext = resolve; }));
    render(<OfficeHome workspaceId={WORKSPACE} />);
    act(() => markSurfaceCacheStale(key));
    // Stale rows stay up while the refetch runs.
    expect(container.textContent).toContain("Quarterly plan");
    expect(container.querySelector("[data-office-home-skeleton]")).toBeNull();
    expect(readSurfaceCache(key).revalidating).toBe(true);
    await act(async () => { resolveNext([{ ...ROW, title: "Quarterly plan v2" }]); await settle(); });
    expect(container.textContent).toContain("Quarterly plan v2");
  });

  it("reads each lifecycle view from its own key", async () => {
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "trash"), async () => [{ ...ROW, title: "Old deck", lifecycleState: "trash" }]);
    api.listOfficeArtifacts.mockImplementation(pending);
    navigation.search = "view=trash";
    render(<OfficeHome workspaceId={WORKSPACE} />);
    expect(container.textContent).toContain("Old deck");
  });
});

describe("[COMP:app-web/office-surface-cache] Office editor shell", () => {
  it("paints the chrome from the home's list row before the snapshot resolves, and fetches row + snapshot in parallel (N7)", async () => {
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "active"), async () => [ROW]);
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Quarterly plan");
    expect(container.querySelector('[data-office-editor-skeleton="document"]')).not.toBeNull();
    expect(container.textContent).not.toContain(en.office.editorLoading);
    // Both requests left in the same tick: no artifact -> snapshot waterfall.
    expect(api.getOfficeArtifact).toHaveBeenCalledTimes(1);
    expect(api.getOfficeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("paints the editor on the first frame from warmed row + snapshot keys (N1)", async () => {
    await loadSurfaceCache(officeArtifactCacheKey(ARTIFACT), async () => ROW);
    await loadSurfaceCache(officeSnapshotCacheKey(ARTIFACT), async () => SNAPSHOT);
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.querySelector('[data-office-shell-state="ready"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="document-editor"]')?.getAttribute("data-artifact")).toBe(ARTIFACT);
    expect(container.querySelector("[data-office-editor-skeleton]")).toBeNull();
  });

  it("keeps the editor up while a stale snapshot revalidates (N3)", async () => {
    await loadSurfaceCache(officeArtifactCacheKey(ARTIFACT), async () => ROW);
    await loadSurfaceCache(officeSnapshotCacheKey(ARTIFACT), async () => SNAPSHOT);
    api.getOfficeArtifact.mockImplementation(async () => ROW);
    let resolveSnapshot: (value: typeof SNAPSHOT) => void = () => undefined;
    api.getOfficeSnapshot.mockImplementation(() => new Promise<typeof SNAPSHOT>((resolve) => { resolveSnapshot = resolve; }));
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    act(() => markSurfaceCacheStale(officeSnapshotCacheKey(ARTIFACT)));
    expect(container.querySelector('[data-testid="document-editor"]')).not.toBeNull();
    expect(container.querySelector("[data-office-editor-skeleton]")).toBeNull();
    await act(async () => { resolveSnapshot({ ...SNAPSHOT, seq: 8 }); await settle(); });
    expect(container.querySelector('[data-testid="document-editor"]')).not.toBeNull();
  });

  it("renders the bare topbar over a skeleton when nothing is known (N4)", () => {
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.querySelector('[data-office-shell-state="loading"]')).not.toBeNull();
    expect(container.querySelector("[data-office-editor-skeleton]")).not.toBeNull();
    expect(container.textContent).not.toContain(en.office.editorLoading);
  });

  it("lifts the recorder pill above the phone toolbar only for a Document (report B row 15)", async () => {
    await loadSurfaceCache(officeArtifactCacheKey(ARTIFACT), async () => ROW);
    await loadSurfaceCache(officeSnapshotCacheKey(ARTIFACT), async () => SNAPSHOT);
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.querySelector('[data-testid="recorder"]')?.className).toContain("max-sm:bottom-20");
  });
});

describe("[COMP:app-web/office-surface-cache] helpers", () => {
  it("finds the artifact row in whichever view's cached list carries it", async () => {
    expect(officeArtifactFromListCache(WORKSPACE, ARTIFACT)).toBeNull();
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "archived"), async () => [{ ...ROW, lifecycleState: "archived" }]);
    expect(officeArtifactFromListCache(WORKSPACE, ARTIFACT)?.lifecycleState).toBe("archived");
    expect(officeArtifactFromListCache("other", ARTIFACT)).toBeNull();
  });

  it("invalidateOfficeList drops every view of one workspace and nothing else", async () => {
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "active"), async () => ["a"]);
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "trash"), async () => ["t"]);
    await loadSurfaceCache(officeListCacheKey("other", "active"), async () => ["other"]);
    invalidateOfficeList(WORKSPACE);
    expect(readSurfaceCache(officeListCacheKey(WORKSPACE, "active")).data).toBeUndefined();
    expect(readSurfaceCache(officeListCacheKey(WORKSPACE, "trash")).data).toBeUndefined();
    expect(readSurfaceCache(officeListCacheKey("other", "active")).data).toEqual(["other"]);
    invalidateSurfaceCache("office:");
  });

  it("marks the given prefixes stale when the tab comes back to the foreground, keeping the rows", async () => {
    const key = officeListCacheKey(WORKSPACE, "active");
    await loadSurfaceCache(key, async () => [ROW]);
    function Probe() { useOfficeCacheRevalidation([`office:${WORKSPACE}:`]); return null; }
    render(<Probe />);
    expect(readSurfaceCache(key).updatedAt).toBeGreaterThan(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(readSurfaceCache(key).updatedAt).toBe(0);
    expect(readSurfaceCache(key).data).toEqual([ROW]);
  });
});
