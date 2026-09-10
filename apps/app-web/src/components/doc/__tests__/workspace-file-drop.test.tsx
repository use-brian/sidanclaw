// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const authHarness = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: authHarness.authFetch,
  getValidAccessToken: vi.fn(),
}));
vi.mock("@/lib/desktop-auth-source", () => ({
  usesGatewayCredentials: vi.fn(() => false),
}));
vi.mock("@/lib/recordings/use-recording-upload", () => ({
  useRecordingUpload: () => ({
    run: vi.fn(),
    dismiss: vi.fn(),
    status: "idle",
    uploadProgress: 0,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { WorkspaceFileDropBoundary } from "../workspace-file-drop";

/**
 * [COMP:app-web/workspace-file-drop] The workspace shell catches neutral file
 * drops for review while a marked contextual drop surface keeps ownership.
 */
describe("[COMP:app-web/workspace-file-drop] WorkspaceFileDropBoundary", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    authHarness.authFetch.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function mount({ offline = false }: { offline?: boolean } = {}) {
    root = createRoot(host!);
    act(() => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <WorkspaceFileDropBoundary
            workspaceId="ws-1"
            assistantId="assistant-1"
            offline={offline}
          >
            <div id="neutral-surface">Workspace surface</div>
            <div id="contextual-drop" data-file-drop-owner="true">
              Chat attachment surface
            </div>
          </WorkspaceFileDropBoundary>
        </I18nProvider>,
      );
    });
  }

  function dispatchDrop(target: Element, files: File[], types = ["Files"]) {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files, types },
      configurable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("stages a neutral workspace drop for review without uploading", () => {
    mount();
    const file = new File(["notes"], "planning-notes.md", { type: "text/markdown" });
    const event = dispatchDrop(host!.querySelector("#neutral-surface")!, [file]);

    expect(event.defaultPrevented).toBe(true);
    expect(document.body.textContent).toContain("Add files to your brain");
    expect(document.body.textContent).toContain("planning-notes.md");
    expect(authHarness.authFetch).not.toHaveBeenCalled();
  });

  it("lets a marked contextual file workflow override the fallback", () => {
    mount();
    const file = new File(["notes"], "chat-notes.md", { type: "text/markdown" });
    const event = dispatchDrop(host!.querySelector("#contextual-drop")!, [file]);

    expect(event.defaultPrevented).toBe(false);
    expect(document.body.textContent).not.toContain("chat-notes.md");
    expect(authHarness.authFetch).not.toHaveBeenCalled();
  });

  it("keeps an offline drop staged until the workspace reconnects", () => {
    mount({ offline: true });
    const file = new File(["notes"], "offline-notes.md", { type: "text/markdown" });
    dispatchDrop(host!.querySelector("#neutral-surface")!, [file]);

    expect(document.body.textContent).toContain("offline-notes.md");
    expect(document.body.textContent).toContain("after you reconnect");
    const addButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Add to brain",
    );
    expect(addButton?.disabled).toBe(true);
  });

  it("ignores non-file application drags", () => {
    mount();
    const event = dispatchDrop(host!.querySelector("#neutral-surface")!, [], ["text/plain"]);

    expect(event.defaultPrevented).toBe(false);
    expect(document.body.textContent).not.toContain("Add files to your brain");
  });
});
