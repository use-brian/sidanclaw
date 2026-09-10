// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getCrmPrivacyPolicy: vi.fn(), saveCrmPrivacyPolicy: vi.fn(), confirmDialog: vi.fn() }));
vi.mock("@/lib/api/crm", () => api);
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: api.confirmDialog }));
import { CrmPrivacyPolicySettings } from "../operations/privacy-policy-settings";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const t = en.crmPage.operations;
const click = async (label: string) => { await act(async () => {
  [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
}); };
async function change(value: string) {
  await act(async () => { const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);
    input.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(async () => {
  vi.resetAllMocks();
  api.getCrmPrivacyPolicy.mockResolvedValue({ version: 0,policy: { intakeReplay: null } });
  api.confirmDialog.mockResolvedValue(true);
  api.saveCrmPrivacyPolicy.mockResolvedValue({ record: { version: 1,policy: { intakeReplay: { retentionSeconds: 7200 } } },created: true });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><CrmPrivacyPolicySettings workspaceId="workspace-1" /></I18nProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("[COMP:app-web/crm-operations] Replay policy approval", () => {
  it("starts unconfigured and submits the exact selected period after confirmation", async () => {
    expect(host.querySelector("input")!.value).toBe("");
    await change("7200"); await click(t.replayPolicyApprove);
    expect(api.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining("7200") }));
    expect(api.saveCrmPrivacyPolicy).toHaveBeenCalledWith("workspace-1", { expectedVersion: 0,confirmed: true,intakeReplay: { retentionSeconds: 7200 } });
    expect(host.textContent).toContain(t.replayPolicySaved);
  });
  it("does not submit a cancelled approval or invalid duration", async () => {
    await change("-1"); await click(t.replayPolicyApprove);
    expect(api.confirmDialog).not.toHaveBeenCalled();
    await change("60"); api.confirmDialog.mockResolvedValue(false); await click(t.replayPolicyApprove);
    expect(api.saveCrmPrivacyPolicy).not.toHaveBeenCalled();
  });
  it("keeps stale saves unsuccessful until the operator refreshes and reviews the current version", async () => {
    api.saveCrmPrivacyPolicy.mockRejectedValueOnce(new Error("stale_privacy_policy_version"));
    await change("7200"); await click(t.replayPolicyApprove);
    expect(host.textContent).toContain(t.replayPolicySaveFailed);
    expect(host.textContent).not.toContain(t.replayPolicySaved);
    api.getCrmPrivacyPolicy.mockResolvedValue({ version: 2,policy: { intakeReplay: { retentionSeconds: 60 } } });
    await click(t.refresh);
    expect(host.querySelector("input")!.value).toBe("60");
    await change(""); await click(t.replayPolicyApprove);
    expect(api.saveCrmPrivacyPolicy).toHaveBeenLastCalledWith("workspace-1", { expectedVersion: 2,confirmed: true,intakeReplay: null });
  });
});
