// @vitest-environment jsdom

/**
 * [COMP:app-web/crm-sidebar-panel] The CRM rail reads the SURFACE's cache
 * slots instead of fetching the flat record set for itself.
 *
 * Pinned: a warmed config + summary + lookups + drafts + approvals set paints
 * every count with NO request of the panel's own; the spine's `crm:<wid>:`
 * mark-stale keeps the counts up while the regions revalidate; the summary
 * key the panel reads is the SAME one the surface builds (the selected
 * pipeline resolves through the shared `resolveSelectedPipeline`).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { CrmConfig, CrmDirectories, CrmEmailDraft, CrmSummary } from "@/lib/api/crm";
import type { PendingApprovalRow } from "@/lib/api/approvals";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import {
  approvalsCacheKey,
  crmConfigCacheKey,
  crmRegionCacheKey,
} from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/w1/crm",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const crmApi = vi.hoisted(() => ({
  fetchCrmConfig: vi.fn(),
  fetchCrmDirectories: vi.fn(),
  fetchCrmEmailDrafts: vi.fn(),
  fetchCrmSummary: vi.fn(),
}));
vi.mock("@/lib/api/crm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/crm")>()),
  ...crmApi,
}));

const approvalsApi = vi.hoisted(() => ({ listApprovals: vi.fn() }));
vi.mock("@/lib/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/approvals")>()),
  listApprovals: approvalsApi.listApprovals,
}));

import { CrmSidebarPanel } from "../crm-sidebar-panel";

const config: CrmConfig = {
  pipelines: [
    { id: "sales", name: "Sales", isDefault: true, position: 0, stages: [] },
    { id: "renewals", name: "Renewals", isDefault: false, position: 1, stages: [] },
  ],
  fields: [],
};
const summary: CrmSummary = {
  totals: { deals: 4, contacts: 7, companies: 2 },
  attention: { overdue: 1, stale: 2, noAmount: 0, orphaned: 3 },
  stages: [],
};
const directories: CrmDirectories = { contacts: [], companies: [], deals: [] };
const drafts: CrmEmailDraft[] = [
  {
    id: "draft-1", status: "draft", revision: 1, from: null, to: ["a@example.com"], cc: [], bcc: [],
    subject: "Hello", body: "", attachments: [], sourceSessionId: null,
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
  },
];
const approvals: PendingApprovalRow[] = [];

const pending = <T,>() => new Promise<T>(() => {});

async function warmAll() {
  await loadSurfaceCache(crmConfigCacheKey("w1"), async () => config);
  // The SAME key the surface reads: `summary:<selected pipeline id>`.
  await loadSurfaceCache(crmRegionCacheKey("w1", "summary", "sales"), async () => summary);
  await loadSurfaceCache(crmRegionCacheKey("w1", "lookups"), async () => directories);
  await loadSurfaceCache(crmRegionCacheKey("w1", "email-drafts"), async () => drafts);
  await loadSurfaceCache(approvalsCacheKey("w1"), async () => approvals);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <CrmSidebarPanel workspaceId="w1" />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
}

const anchor = (href: string) =>
  [...container!.querySelectorAll("a")].find((a) => a.getAttribute("href") === href) ?? null;
const sectionCount = (href: string) =>
  anchor(href)?.querySelector("span.tabular-nums")?.textContent ?? null;
const badgeOf = (href: string) =>
  anchor(href)?.querySelector("span.rounded-full")?.textContent ?? null;
const skeletons = () => container!.querySelectorAll("[data-sidebar-count-skeleton]").length;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const fetchCalls = () =>
  crmApi.fetchCrmConfig.mock.calls.length +
  crmApi.fetchCrmDirectories.mock.calls.length +
  crmApi.fetchCrmEmailDrafts.mock.calls.length +
  crmApi.fetchCrmSummary.mock.calls.length +
  approvalsApi.listApprovals.mock.calls.length;

beforeEach(() => {
  resetSurfaceCache();
  for (const fn of [
    crmApi.fetchCrmConfig,
    crmApi.fetchCrmDirectories,
    crmApi.fetchCrmEmailDrafts,
    crmApi.fetchCrmSummary,
    approvalsApi.listApprovals,
  ]) {
    fn.mockReset();
    fn.mockImplementation(() => pending());
  }
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/crm-sidebar-panel] counts from the surface's cache slots", () => {
  it("paints section, attention and draft counts from the warmed keys with NO request of its own", async () => {
    await warmAll();
    await render();

    expect(sectionCount("/w/w1/crm")).toBe("4");
    expect(sectionCount("/w/w1/crm?section=contacts")).toBe("7");
    expect(sectionCount("/w/w1/crm?section=companies")).toBe("2");
    expect(badgeOf("/w/w1/crm?filter=overdue&view=table")).toBe("1");
    expect(badgeOf("/w/w1/crm?filter=orphaned")).toBe("3");
    expect(badgeOf("/w/w1/crm?review=email")).toBe("1");
    expect(skeletons()).toBe(0);
    expect(fetchCalls()).toBe(0);
  });

  it("keeps the counts painted through the spine's crm: mark-stale and updates when the summary lands", async () => {
    await warmAll();
    let resolveSummary!: (value: CrmSummary) => void;
    crmApi.fetchCrmSummary.mockImplementation(
      () => new Promise<CrmSummary>((r) => { resolveSummary = r; }),
    );
    await render();

    await act(async () => {
      markSurfaceCacheStale("crm:w1:");
    });
    await settle();

    expect(sectionCount("/w/w1/crm")).toBe("4");
    expect(skeletons()).toBe(0);
    expect(crmApi.fetchCrmSummary).toHaveBeenCalledWith("w1", "sales");

    await act(async () => {
      resolveSummary({ ...summary, totals: { ...summary.totals, deals: 5 } });
    });
    await settle();
    expect(sectionCount("/w/w1/crm")).toBe("5");
  });

  it("shows skeleton pills while every slot is cold, and starts the shared loads once", async () => {
    await render();

    expect(sectionCount("/w/w1/crm")).toBeNull();
    expect(skeletons()).toBeGreaterThan(0);
    expect(crmApi.fetchCrmConfig).toHaveBeenCalledTimes(1);
    expect(crmApi.fetchCrmDirectories).toHaveBeenCalledTimes(1);
    expect(crmApi.fetchCrmEmailDrafts).toHaveBeenCalledTimes(1);
    expect(approvalsApi.listApprovals).toHaveBeenCalledTimes(1);
  });

  it("carries no refresh listener of its own (the spine map owns crm: and approvals:)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "src/components/doc/sidebar-panels/crm-sidebar-panel.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/addEventListener\(/);
    expect(src).not.toContain('from "@/lib/brain-events"');
    expect(src).not.toContain('from "@/lib/approvals-events"');
    expect(src).not.toContain("fetchWorkspaceCrm(");
    expect(src).toContain("crmRegionCacheKey(workspaceId, \"summary\"");
    expect(src).toContain("approvalsCacheKey(workspaceId)");
  });
});
