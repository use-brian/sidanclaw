// @vitest-environment jsdom
/**
 * [COMP:app-web/workspace-switcher] The switcher paints the shared workspace
 * list on its first open (instant-navigation contract N1 / N4 / N5).
 *
 * Report E: the popover kept a private `/api/workspaces` copy and showed a
 * "Loading workspaces..." line on every first open per page load, while
 * `contexts/workspace-context.tsx` already held the same list for every
 * ported surface. The contract under test: a list already in the shared
 * cache paints on the first open with no fetch; a genuinely cold list shows
 * skeleton rows (never the loading sentence) and swaps to rows when the
 * shared fetch lands; a rename event patches the shared list so the rows
 * follow.
 */

import { act, createContext, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({
    workspaceId: "w1",
    name: "Acme",
    iconSeed: null,
    iconUrl: null,
    role: "owner",
    clearance: "internal",
    me: { id: "u1" },
  }),
  WORKSPACE_ICON_CHANGED_EVENT: "brian:workspace-icon-changed",
  WORKSPACE_RENAMED_EVENT: "brian:workspace-renamed",
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  const { format } = await import("@/lib/i18n/format");
  return { useT: () => en, format };
});
vi.mock("@/lib/desktop-auth-source", () => ({ desktopBridge: () => null }));
const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: authFetchMock }));
vi.mock("@/lib/primary-auth", () => ({
  primaryAuthUrl: () => null,
  webAppUrl: () => "",
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "U", email: "u@example.com" }),
}));
vi.mock("@/lib/account-logout", () => ({ signOutActiveAccount: vi.fn() }));
vi.mock("@/lib/sidebar-close", () => ({ requestSidebarClose: vi.fn() }));
vi.mock("@/lib/edition", () => ({
  deploymentCapabilities: () => ({ billing: false }),
}));
vi.mock("@/lib/api/workspaces", () => ({
  updateWorkspacePickerPreferences: vi.fn(async () => ({})),
}));
vi.mock("@/lib/accounts", () => ({ getAccountsDir: () => [] }));
vi.mock("@/lib/route-progress", () => ({ routeProgress: { start: vi.fn() } }));
vi.mock("@/components/team-avatar", () => ({ TeamAvatar: () => null }));
vi.mock("@/components/desktop-accounts", () => ({ DesktopAccounts: () => null }));
vi.mock("@/components/ui/user-avatar", () => ({ UserAvatar: () => null }));
vi.mock("@/components/create-workspace-form", () => ({
  CreateWorkspaceForm: () => null,
}));
vi.mock("@/components/settings-modal/settings-modal", () => ({
  SettingsModal: () => null,
  OPEN_SETTINGS_EVENT: "brian:open-settings",
}));
// A minimal popover: the trigger toggles `open`, the content renders only
// while open. Enough to exercise the first-open paint without base-ui.
vi.mock("@/components/ui/popover", () => {
  const Ctx = createContext<{ open: boolean; onOpenChange: (o: boolean) => void }>({
    open: false,
    onOpenChange: () => {},
  });
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (o: boolean) => void;
      children: ReactNode;
    }) => <Ctx.Provider value={{ open, onOpenChange }}>{children}</Ctx.Provider>,
    PopoverTrigger: ({
      children,
      ...props
    }: {
      children: ReactNode;
      [key: string]: unknown;
    }) => {
      const ctx = useContext(Ctx);
      const { ref: _ref, ...rest } = props as { ref?: unknown };
      return (
        <button
          type="button"
          data-testid="trigger"
          {...(rest as Record<string, unknown>)}
          onClick={() => ctx.onOpenChange(!ctx.open)}
        >
          {children}
        </button>
      );
    },
    PopoverContent: ({ children }: { children: ReactNode; [key: string]: unknown }) => {
      const ctx = useContext(Ctx);
      return ctx.open ? <div data-testid="content">{children}</div> : null;
    },
  };
});

import {
  __resetWorkspaceCacheForTest,
  setWorkspaces,
} from "@/contexts/workspace-context";
import { WORKSPACE_RENAMED_EVENT } from "@/lib/workspace-context";
import { WorkspaceSwitcher } from "../workspace-switcher";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("[COMP:app-web/workspace-switcher] paints the shared workspace list", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    __resetWorkspaceCacheForTest();
    authFetchMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function mount() {
    await act(async () => {
      root!.render(<WorkspaceSwitcher />);
      await settle();
    });
  }

  async function open() {
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!.click();
      await settle();
    });
  }

  const content = () => container!.querySelector('[data-testid="content"]');
  const rowNames = () =>
    Array.from(content()!.querySelectorAll('ul li button[role="menuitem"] span.flex-1')).map(
      (el) => el.textContent,
    );

  it("first open paints an already-fetched list with no fetch and no loading line", async () => {
    setWorkspaces([
      { id: "w1", name: "Acme" },
      { id: "w2", name: "Beta" },
    ]);
    authFetchMock.mockImplementation(() => new Promise(() => {}));
    await mount();
    await open();

    expect(rowNames()).toEqual(["Acme", "Beta"]);
    expect(content()!.querySelector("[aria-busy]")).toBeNull();
    expect(content()!.textContent).not.toContain("Loading workspaces");
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("a cold list shows skeleton rows, never the loading sentence, then the rows when the shared fetch lands", async () => {
    let release: (value: unknown) => void = () => {};
    authFetchMock.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    await mount();
    // The mount-time warm already started the ONE shared request.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    await open();

    expect(content()!.querySelector("ul[aria-busy='true']")).not.toBeNull();
    expect(content()!.textContent).not.toContain("Loading workspaces");
    // Opening joined the in-flight warm instead of starting a second request.
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({
        ok: true,
        json: async () => ({ workspaces: [{ id: "w1", name: "Acme" }, { id: "w3", name: "Gamma" }] }),
      });
      await settle();
    });
    expect(content()!.querySelector("[aria-busy]")).toBeNull();
    expect(rowNames()).toEqual(["Acme", "Gamma"]);
  });

  it("a rename event patches the shared list so the rows follow without a refetch", async () => {
    setWorkspaces([
      { id: "w1", name: "Acme" },
      { id: "w2", name: "Beta" },
    ]);
    await mount();
    await open();
    expect(rowNames()).toEqual(["Acme", "Beta"]);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_RENAMED_EVENT, {
          detail: { workspaceId: "w2", name: "Beta Robotics" },
        }),
      );
      await settle();
    });
    expect(rowNames()).toEqual(["Acme", "Beta Robotics"]);
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});
