// @vitest-environment jsdom
/**
 * [COMP:app-web/recordings-board] The recordings board paints from the
 * surface cache (instant-navigation contract N1); its in-flight poll is a
 * `refresh()` on the key, not a private row copy.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { RecordingSummary } from "@/lib/api/recordings";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { recordingsCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaces: () => ({ activeId: "w1", workspaces: [], active: null }),
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: () => <div data-testid="status-select" />,
}));

const api = vi.hoisted(() => ({ listRecordings: vi.fn() }));
vi.mock("@/lib/api/recordings", () => ({
  listRecordings: (...args: unknown[]) => api.listRecordings(...args),
}));

import { RecordingsPanel } from "../recordings-panel";

const dict = en as unknown as Dictionary;

const rec = (id: string, title: string): RecordingSummary => ({
  recordingId: id,
  title,
  fileName: `${id}.webm`,
  kind: "meeting",
  status: "processed",
  mime: "audio/webm",
  durationMs: 60_000,
  bytes: 1024,
  occurredAt: new Date().toISOString(),
  truncated: false,
  lastError: null,
  hasTranscript: true,
  transcriptFileId: "f1",
  participants: [],
});

const pending = () => new Promise<never>(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <RecordingsPanel />
      </I18nProvider>,
    );
    await settle();
  });
}

beforeEach(() => {
  resetSurfaceCache();
  api.listRecordings.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("[COMP:app-web/recordings-board] recordings board paints from the surface cache", () => {
  it("first paint renders the warmed rows while the fetch is still pending", async () => {
    const key = recordingsCacheKey("w1", "all", "");
    await loadSurfaceCache(key, async () => [rec("r1", "Weekly sync")]);
    markSurfaceCacheStale(key);
    api.listRecordings.mockReturnValue(pending());

    await mount();

    expect(host!.textContent).toContain("Weekly sync");
    expect(host!.querySelector("[aria-busy]")).toBeNull();
    expect(host!.textContent).not.toContain(en.recordings.panelLoading);
    expect(api.listRecordings).toHaveBeenCalledTimes(1);
  });

  it("a cold cache paints skeleton rows, never the Loading sentence (N4)", async () => {
    api.listRecordings.mockReturnValue(pending());
    await mount();
    expect(host!.querySelector("[aria-busy]")).not.toBeNull();
    expect(host!.textContent).not.toContain(en.recordings.panelLoading);
  });

  it("a mark-stale repaints behind the paint: rows stay up, then update", async () => {
    const key = recordingsCacheKey("w1", "all", "");
    await loadSurfaceCache(key, async () => [rec("r1", "Weekly sync")]);
    await mount();

    let resolveList: (rows: RecordingSummary[]) => void = () => {};
    api.listRecordings.mockReturnValue(
      new Promise<RecordingSummary[]>((resolve) => {
        resolveList = resolve;
      }),
    );
    await act(async () => {
      markSurfaceCacheStale("recordings:w1");
      await settle();
    });
    expect(host!.textContent).toContain("Weekly sync");
    expect(host!.querySelector("[aria-busy]")).toBeNull();

    await act(async () => {
      resolveList([rec("r1", "Weekly sync"), rec("r2", "Board prep")]);
      await settle();
    });
    expect(host!.textContent).toContain("Board prep");
  });
});
