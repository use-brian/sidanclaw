// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { LiveRecordingPage } from "@/lib/api/recordings";
import { useLiveRecordingPage } from "../use-live-recording-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => ({ recorder: {} }) }));
vi.mock("@/lib/api/recordings", () => ({ startLiveRecordingPage: vi.fn(), streamLiveRecordingWindow: mocks.stream }));

describe("[COMP:app-web/live-recording-page] overlapping session windows", () => {
  it("keeps destinations and missed-window counts session-scoped while old work drains", async () => {
    let hook!: ReturnType<typeof useLiveRecordingPage>;
    function Harness() { hook = useLiveRecordingPage("workspace-1", "assistant-1"); return null; }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      const [a, b]: LiveRecordingPage[] = ["a", "b"].map((id) => ({
        pageId: `page-${id}`, sessionId: `session-${id}`, title: "Meeting", notesHeadingId: "heading", markerBlockId: "marker",
      }));
      const window = { blob: new Blob(["audio"]), mime: "audio/webm", startMs: 0, endMs: 30_000 };
      mocks.stream.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ duplicate: true });
      await hook.streamWindow(window, a);
      await hook.streamWindow(window, b);
      await hook.streamWindow(window, a);
      await hook.streamWindow(window, a);
      expect(mocks.stream.mock.calls.map(([input]) => [input.page.sessionId, input.missedWindows])).toEqual([
        ["session-a", 0], ["session-b", 0], ["session-a", 1], ["session-a", 0],
      ]);
    } finally {
      act(() => root.unmount());
      mocks.stream.mockReset();
    }
  });
});
