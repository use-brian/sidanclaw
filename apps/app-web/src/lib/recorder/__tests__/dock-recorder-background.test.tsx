// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDockRecorder, type DockRecorderApi, type MeetingCaptureOutcome } from "../use-dock-recorder";
import type { RecorderEngine } from "../recorder-engine";
import { memorySpoolStore, type SpoolSessionMeta, type SpoolStore } from "../recorder-spool";
import type { LiveRecordingPage } from "@/lib/api/recordings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ createEngine: vi.fn(), uploadVoiceClip: vi.fn(), store: null as SpoolStore | null }));
vi.mock("../recorder-engine", () => ({ createRecorderEngine: mocks.createEngine }));
vi.mock("../recorder-spool", async (original) => ({
  ...await original<typeof import("../recorder-spool")>(),
  openRecorderSpool: () => mocks.store!,
}));
vi.mock("../webm-duration", () => ({ patchRecordingBlob: async (blob: Blob) => blob }));
vi.mock("../voice-clip", () => ({ uploadVoiceClip: mocks.uploadVoiceClip }));
vi.mock("@/lib/desktop-auth-source", () => ({ desktopBridge: () => undefined }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeEngine(durationMs = 180_000, liveWindowsDone?: Promise<void>) {
  const blob = new Blob(["captured audio"], { type: "audio/webm" });
  let id: string | null = null;
  let flush = Promise.resolve();
  const engine: RecorderEngine = {
    elapsedMs: () => durationMs, level: () => 0, includesSystemAudio: () => false,
    capturesVideo: () => false, paused: () => false,
    pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    latch(store, meta) {
      id = meta.id;
      flush = store.createSession({ ...meta, mime: blob.type, elapsedMs: durationMs, chunkCount: 0, updatedAt: Date.now() })
        .then(() => store.appendChunk(meta.id, 0, blob, durationMs));
    },
    spoolSessionId: () => id,
    stop: vi.fn(async () => { await flush; return { blob, mime: blob.type, durationMs, liveWindowsDone }; }),
  };
  mocks.createEngine.mockResolvedValueOnce(engine);
  return engine;
}

let api: DockRecorderApi;
let root: Root;
let container: HTMLDivElement;
let options: Parameters<typeof useDockRecorder>[0];
function Harness() { api = useDockRecorder(options); return null; }
async function render() { await act(async () => root.render(<Harness />)); }
async function start() {
  await act(async () => { api.onPressStart(); api.onPressEnd(); });
  expect(api.phase.kind).toBe("latched");
}
async function stop() { await act(async () => api.stop()); }
const queued: MeetingCaptureOutcome = { outcome: "queued", message: "Recording queued" };

describe("[COMP:app-web/dock-recorder] non-blocking saves", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.store = memorySpoolStore();
    options = {
      enabled: true, workspaceId: "workspace-1", assistantId: "assistant-1", captureNamePrefix: "Recording",
      sendVoiceClip: vi.fn().mockResolvedValue(true), onMeetingCapture: vi.fn().mockResolvedValue(queued),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("releases after the local flush, serializes saves, and never resets a newer capture", async () => {
    const first = deferred<MeetingCaptureOutcome>();
    const second = deferred<MeetingCaptureOutcome>();
    const upload = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    options.onMeetingCapture = upload;
    const a = makeEngine(); const b = makeEngine(); const c = makeEngine();
    const localFlush = deferred<Awaited<ReturnType<RecorderEngine["stop"]>>>();
    vi.mocked(a.stop).mockReturnValueOnce(localFlush.promise);
    await render(); await start(); await stop();
    expect(api.phase.kind).toBe("finishing");
    expect(upload).not.toHaveBeenCalled();
    await act(async () => localFlush.resolve({ blob: new Blob(["first"]), mime: "audio/webm", durationMs: 180_000 }));
    expect(api.phase.kind).toBe("idle");
    expect(api.savingCount).toBe(1);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await start(); await stop();
    expect(api.savingCount).toBe(2);
    expect(upload).toHaveBeenCalledTimes(1);
    await start();
    await act(async () => first.resolve(queued));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(api.phase.kind).toBe("latched");
    expect(api.elapsedMs()).toBe(180_000);
    expect((await mocks.store!.listSessions()).map((s) => s.id)).toEqual([b.spoolSessionId(), c.spoolSessionId()]);
    await act(async () => second.resolve(queued));
    expect(api.savingCount).toBe(0);
    expect(api.phase.kind).toBe("latched");
    act(() => api.pause());
    expect(c.pause).toHaveBeenCalledTimes(1);
    expect(a.pause).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "failed", "throw"])("retains a %s save, hides pending recovery and continues the queue", async (outcome) => {
    const first = deferred<MeetingCaptureOutcome>();
    const upload = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(queued);
    options.onMeetingCapture = upload;
    const a = makeEngine(); makeEngine();
    await render(); await start(); await stop(); await start(); await stop();
    await act(async () => vi.advanceTimersByTimeAsync(35_000));
    expect(api.recovery).toEqual([]);
    await act(async () => {
      await api.saveRecovery(a.spoolSessionId()!);
      await api.discardRecovery(a.spoolSessionId()!);
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await mocks.store!.listSessions()).toHaveLength(2);
    await act(async () => {
      if (outcome === "throw") first.reject(new Error("upload failed"));
      else first.resolve(outcome === "cancelled" ? { outcome } : { outcome: "failed", message: "Upload failed" });
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(api.savingCount).toBe(0);
    expect(api.recovery.map((s) => s.id)).toEqual([a.spoolSessionId()]);
    expect(await mocks.store!.listSessions()).toHaveLength(1);
  });

  it("also frees short voice capture without making it wait behind a meeting save", async () => {
    const meeting = deferred<MeetingCaptureOutcome>();
    const voice = deferred<string>();
    options.onMeetingCapture = vi.fn().mockReturnValue(meeting.promise);
    mocks.uploadVoiceClip.mockReturnValue(voice.promise);
    const a = makeEngine(); const b = makeEngine(30_000); makeEngine();
    await render(); await start(); await stop(); await start(); await stop();
    expect(api.phase.kind).toBe("idle");
    expect(mocks.uploadVoiceClip).toHaveBeenCalledTimes(1);
    expect(api.savingCount).toBe(2);
    await start();
    await act(async () => voice.resolve("voice-file-1"));
    expect(options.sendVoiceClip).toHaveBeenCalledWith("voice-file-1");
    expect(api.phase.kind).toBe("latched");
    expect(api.savingCount).toBe(1);
    expect((await mocks.store!.listSessions()).map((s) => s.id)).toContain(a.spoolSessionId());
    expect((await mocks.store!.listSessions()).map((s) => s.id)).not.toContain(b.spoolSessionId());
    await act(async () => meeting.resolve(queued));
  });

  it("pins live windows, queued saves and their callbacks to the original destination", async () => {
    const windowsDone = deferred<void>();
    const pages: LiveRecordingPage[] = ["a", "b"].map((id) => ({
      pageId: `page-${id}`, sessionId: `session-${id}`, title: "Meeting", notesHeadingId: "heading", markerBlockId: "marker",
    }));
    const originalUpload = vi.fn().mockResolvedValue(queued);
    const replacementUpload = vi.fn().mockResolvedValue(queued);
    options.onMeetingCapture = originalUpload;
    options.prepareLivePage = vi.fn().mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
    options.streamLiveWindow = vi.fn().mockResolvedValue(undefined);
    makeEngine(180_000, windowsDone.promise); makeEngine();
    await render(); act(() => api.setLivePageEnabled(true)); await start(); await stop();
    expect(api.phase.kind).toBe("idle");
    expect(originalUpload).not.toHaveBeenCalled();
    options = { ...options, assistantId: "assistant-2", onMeetingCapture: replacementUpload };
    await render(); await start();
    const window = { blob: new Blob(["window"]), mime: "audio/webm", startMs: 0, endMs: 30_000 };
    await mocks.createEngine.mock.calls[0][0].onLiveWindow(window);
    expect(options.streamLiveWindow).toHaveBeenLastCalledWith(window, pages[0]);
    await act(async () => windowsDone.resolve());
    expect(originalUpload).toHaveBeenCalledWith(expect.any(File), { pageId: "page-a", sessionId: "session-a" });
    expect(replacementUpload).not.toHaveBeenCalled();
    expect(api.phase.kind).toBe("latched");
    await stop();
    expect(replacementUpload).toHaveBeenCalledWith(expect.any(File), { pageId: "page-b", sessionId: "session-b" });
  });

  it("serializes recovery saves and blocks same-tick duplicate Save/Discard", async () => {
    const pending = deferred<MeetingCaptureOutcome>();
    options.onMeetingCapture = vi.fn().mockReturnValue(pending.promise);
    const meta: SpoolSessionMeta = { id: "recovery-1", workspaceId: "workspace-1", assistantId: "assistant-1", startedAt: 0, updatedAt: 0, elapsedMs: 180_000, chunkCount: 0, mime: "audio/webm" };
    await mocks.store!.createSession(meta);
    await render();
    let saving!: Promise<void>;
    await act(async () => {
      saving = api.saveRecovery(meta.id);
      await api.saveRecovery(meta.id);
      await api.discardRecovery(meta.id);
    });
    expect(options.onMeetingCapture).toHaveBeenCalledTimes(1);
    expect(api.recovery).toEqual([]);
    expect(await mocks.store!.listSessions()).toHaveLength(1);
    await act(async () => { pending.resolve({ outcome: "cancelled" }); await saving; });
    expect(api.recovery).toHaveLength(1);
    expect(api.savingCount).toBe(0);
  });
});
