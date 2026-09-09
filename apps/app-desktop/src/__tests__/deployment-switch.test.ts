import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentAccounts, deploymentAccountKey, type AccountTarget } from "../deployment-accounts.js";
import { serializePersistedTarget } from "../target-store.js";
import type { StoredTokens } from "../desktop-token-store.js";

const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), handlers: new Map<string, Function>(), windows: [] as any[], app: null as any, partitions: new Map<string, any>(), refresh: vi.fn() }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));
vi.mock("../desktop-auth.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../desktop-auth.js")>(), refreshSession: state.refresh }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: (path: string, encoding?: string) => {
    const value = state.files.get(String(path));
    if (!value) throw new Error("ENOENT");
    return encoding ? value.toString() : value;
  },
  writeFileSync: (path: string, data: string | Buffer) => state.files.set(String(path), Buffer.from(data)),
  renameSync: (from: string, to: string) => { state.files.set(to, state.files.get(from)!); state.files.delete(from); },
  rmSync: (path: string) => state.files.delete(String(path)),
  existsSync: (path: string) => String(path).endsWith("renderer/index.html") || state.files.has(String(path)),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), { name: "Use Brian", isPackaged: true,
    getPath: () => "/tmp/desktop-switch-test", requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), focus: vi.fn(), quit: vi.fn(), relaunch: vi.fn(), exit: vi.fn() });
  state.app = app;
  const makeSession = () => Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn(), onBeforeSendHeaders: vi.fn(), onBeforeRedirect: vi.fn(), onCompleted: vi.fn() },
    cookies: { get: vi.fn().mockResolvedValue([]), set: vi.fn(), remove: vi.fn() },
    fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
  });
  class Window extends EventEmitter {
    destroyed = false; preventClose = false; options: any; bounds = { x: 30, y: 40, width: 1000, height: 700 }; webContents: any;
    constructor(options: any) {
      super(); this.options = options;
      let url = "";
      this.webContents = Object.assign(new EventEmitter(), {
        id: state.windows.length + 1, isDestroyed: () => this.destroyed,
        getURL: () => url, loadFile: vi.fn(async (path: string) => { url = `file://${path}`; }),
        loadURL: vi.fn(async (value: string) => { url = value; }), setWindowOpenHandler: vi.fn(), focus: vi.fn(), send: vi.fn(),
      });
      state.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    getBounds() { return this.bounds; }
    setBounds(value: any) { this.bounds = value; }
    show() {} focus() {} setTitle() {}
    close() { if (this.preventClose) this.webContents.emit("will-prevent-unload", {}); else { this.destroyed = true; this.emit("closed"); } }
  }
  return { app, BrowserWindow: Window, ipcMain: { on: (name: string, fn: Function) => state.handlers.set(name, fn), handle: (name: string, fn: Function) => state.handlers.set(name, fn) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    session: { defaultSession: makeSession(), fromPartition: (key: string) => { if (!state.partitions.has(key)) state.partitions.set(key, makeSession()); return state.partitions.get(key); } },
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: vi.fn() },
    dialog: { showErrorBox: vi.fn() }, net: { fetch: vi.fn(), isOnline: () => true },
    powerMonitor: new EventEmitter(), powerSaveBlocker: {}, globalShortcut: {}, shell: {}, screen: {}, systemPreferences: {}, Tray: class {}, Notification: class {}, nativeImage: {}, desktopCapturer: {},
  };
});
const local: AccountTarget = { kind: "local", appUrl: "http://localhost:3003", apiUrl: "http://localhost:4000", auth: "pkce" };
const cloud: AccountTarget = { kind: "cloud", appUrl: "https://app.usebrian.ai", apiUrl: "https://api.usebrian.ai", auth: "pkce" };
const tokens = (name: string): StoredTokens => ({ accessToken: `${name}-access`, refreshToken: `${name}-refresh`, accessTokenExpiresAt: Date.now() + 3600_000, user: { id: "same-user", name, email: "person@example.com" } });
let store: DeploymentAccounts;
beforeEach(async () => {
  vi.resetModules(); state.files.clear(); state.handlers.clear(); state.windows.length = 0; state.partitions.clear();
  vi.stubEnv("USEBRIAN_APP_URL", ""); vi.stubEnv("USEBRIAN_API_URL", ""); vi.stubEnv("USEBRIAN_BUNDLED", "true");
  state.files.set("/tmp/desktop-switch-test/target.json", Buffer.from(serializePersistedTarget("local", local.appUrl, local.apiUrl, local.auth)));
  store = new DeploymentAccounts({ isAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    () => state.files.get("/tmp/desktop-switch-test/deployment-accounts.bin")!,
    (blob) => { state.files.set("/tmp/desktop-switch-test/deployment-accounts.bin", blob); });
  store.put(local, tokens("local")); store.put(cloud, tokens("cloud"));
  state.refresh.mockReset().mockResolvedValue({ accessToken: "cloud-new", refreshToken: "cloud-rotated", accessTokenExpiresIn: 3600 });
  await import("../main.js");
  state.app.emit("second-instance", {}, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
afterEach(() => { vi.unstubAllEnvs(); });
const sender = () => ({ sender: state.windows.at(-1).webContents });

describe("[COMP:app-desktop/main] deployment switching", () => {
  it("switches local to cloud and back without restarting, preserving sessions and isolated caches", async () => {
    const first = state.windows[0];
    const key = deploymentAccountKey({ target: cloud, tokens: tokens("cloud") });
    const result = await state.handlers.get("Use Brian:select-account")!(sender(), key);
    expect(result).toEqual({ ok: true });
    expect(state.refresh).toHaveBeenCalledWith(cloud.apiUrl, "cloud-refresh", undefined);
    expect(first.destroyed).toBe(true);
    expect(state.windows).toHaveLength(2);
    expect(state.windows[1].bounds).toEqual(first.bounds);
    expect(state.windows[1].options.webPreferences.session).not.toBe(first.options.webPreferences.session);
    expect(state.app.relaunch).not.toHaveBeenCalled();
    expect(state.app.exit).not.toHaveBeenCalled();
    expect(store.current(local)?.refreshToken).toBe("local-refresh");
    expect(store.current(cloud)?.refreshToken).toBe("cloud-rotated");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const active = { ...sender(), returnValue: undefined as unknown };
    state.handlers.get("Use Brian:get-tokens")!(active);
    expect(active.returnValue).toMatchObject({ accessToken: "cloud-new" });
    const stale = { sender: first.webContents, returnValue: undefined as unknown };
    state.handlers.get("Use Brian:get-tokens")!(stale);
    expect(stale.returnValue).toBeNull();
    state.handlers.get("Use Brian:set-tokens")!(stale, { accessToken: "wrong", refreshToken: "wrong" });
    expect(store.current(cloud)?.refreshToken).toBe("cloud-rotated");
    state.refresh.mockResolvedValue({ accessToken: "local-new", refreshToken: "local-rotated", accessTokenExpiresIn: 3600 });
    expect(await state.handlers.get("Use Brian:select-account")!(sender(), deploymentAccountKey({ target: local, tokens: tokens("local") }))).toEqual({ ok: true });
    expect(state.windows[2].options.webPreferences.session).toBe(first.options.webPreferences.session);
  });
  it("keeps the active account and window if the selected server is offline", async () => {
    state.refresh.mockRejectedValue(new Error("offline"));
    expect(await state.handlers.get("Use Brian:select-account")!(sender(), deploymentAccountKey({ target: cloud, tokens: tokens("cloud") }))).toEqual({ ok: false, error: "switch" });
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].destroyed).toBe(false);
    expect(store.current(local)?.refreshToken).toBe("local-refresh");
  });
  it("honors an unsaved-work close veto without changing the selected target", async () => {
    state.windows[0].preventClose = true;
    expect(await state.handlers.get("Use Brian:select-cloud")!(sender())).toEqual({ ok: false });
    expect(state.windows[0].destroyed).toBe(false);
    expect(JSON.parse(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).kind).toBe("local");
  });
});
