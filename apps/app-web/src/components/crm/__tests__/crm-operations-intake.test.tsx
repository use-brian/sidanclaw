// @vitest-environment jsdom

/** [COMP:app-web/crm-operations] Intake definitions and credential controls. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createCrmIntakeCredential: vi.fn(),
  listCrmIntakeCredentials: vi.fn(),
  listCrmIntakeDefinitions: vi.fn(),
  listCrmConsentPurposes: vi.fn(),
  listCrmOperationsAudit: vi.fn(),
  listCrmEventDelivery: vi.fn(),
  downloadCrmOperationsPrivacyExport: vi.fn(),
  revokeCrmIntakeCredential: vi.fn(),
  saveCrmIntakeDefinition: vi.fn(),
  saveCrmConsentPurpose: vi.fn(),
}));

vi.mock("@/lib/api/crm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm")>(),
  ...api,
}));

vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { CrmIntakeSettings } from "../operations/intake-settings";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const definition = {
  id: "00000000-0000-4000-8000-000000000010",
  definitionKey: "website_contact",
  label: "Website contact",
  active: true,
  currentVersion: 2,
  fields: [],
  identityPolicy: "trusted_verified_email" as const,
  consentMappings: [],
  queueKey: "general",
  maxPayloadBytes: 65_536,
  schemaHash: "schema-hash",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const credential = {
  id: "00000000-0000-4000-8000-000000000020",
  label: "Production form",
  prefix: "sk_intake_demo",
  definitionIds: [definition.id],
  revokedAt: null,
  lastUsedAt: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};

let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  api.listCrmIntakeDefinitions.mockResolvedValue([definition]);
  api.listCrmIntakeCredentials.mockResolvedValue([credential]);
  api.listCrmConsentPurposes.mockResolvedValue([{
    id: "purpose-fixture", purposeKey: "updates", label: "Updates", description: "Existing description",
    requiresConsent: false, applicableChannels: ["email"], wordingVersion: "1", wording: "Default fixture text",
    defaultLocale: "en", localeWordings: { ja: "元の文言" }, archivedAt: null,
  }]);
  api.listCrmOperationsAudit.mockResolvedValue([]);
  api.listCrmEventDelivery.mockResolvedValue([]);
  api.saveCrmIntakeDefinition.mockResolvedValue({ record: definition, created: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={en}>
        <CrmIntakeSettings workspaceId="workspace-1" />
      </I18nProvider>,
    );
  });
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-operations] CRM intake settings", () => {
  it("shows definitions and credential metadata without exposing a stored secret", () => {
    expect(host.textContent).toContain("Website contact");
    expect(host.textContent).toContain("website_contact · v2");
    expect(host.textContent).toContain("Production form");
    expect(host.textContent).toContain("sk_intake_demo · Active");
    expect(host.textContent).not.toContain("secret_hash");
  });

  it("submits a bounded starter definition through the canonical settings API", async () => {
    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    await act(async () => {
      setInput(inputs[0], "Partner form");
      setInput(inputs[1], "partner_form");
    });

    const create = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === en.crmPage.operations.createDefinition,
    );
    expect(create?.disabled).toBe(false);
    await act(async () => { create?.click(); });
    await settle();

    expect(api.saveCrmIntakeDefinition).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        definitionKey: "partner_form",
        label: "Partner form",
        definition: expect.objectContaining({
          identityPolicy: "new_or_review",
          maxPayloadBytes: 65_536,
        }),
      }),
    );
  });
  it("edits a purpose under an explicit new version without losing its existing policy", async () => {
    const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label)!;
    await act(async () => button(en.crmPage.operations.editWording).click());
    const labeledInput = (label: string) => Array.from(host.querySelectorAll("label")).find((item) => item.querySelector("span")?.textContent === label)?.querySelector("input")!;
    expect(labeledInput(en.crmPage.operations.purposeKey).disabled).toBe(true);
    expect(labeledInput(en.crmPage.operations.wordingVersion).value).toBe("1");
    await act(async () => {
      setInput(labeledInput(en.crmPage.operations.wordingVersion), "2");
      const translation = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Optional translation (日本語)"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(translation, "新しい文言");
      translation.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(en.crmPage.operations.saveWordingVersion).click());
    await settle();
    expect(api.saveCrmConsentPurpose).toHaveBeenCalledWith("workspace-1", {
      purposeId: "purpose-fixture", purposeKey: "updates", label: "Updates", description: "Existing description",
      requiresConsent: false, applicableChannels: ["email"], wordingVersion: "2", wording: "Default fixture text",
      defaultLocale: "en", localeWordings: { ja: "新しい文言" }, archived: false,
    });
    expect(host.textContent).toContain(en.crmPage.operations.wordingImmutableHelp);
  });

  it("creates a replacement with the existing bindings and keeps revocation explicit", async () => {
    api.createCrmIntakeCredential.mockResolvedValue({ record: credential,key: "sk_intake_replacement_fixture" });
    const replace = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === en.crmPage.operations.rotateCredential)!;
    await act(async () => replace.click());
    await settle();
    expect(api.createCrmIntakeCredential).toHaveBeenCalledWith("workspace-1", {
      label: credential.label,definitionIds: credential.definitionIds,rotateFromCredentialId: credential.id,
    });
    expect(api.revokeCrmIntakeCredential).not.toHaveBeenCalled();
    expect(host.textContent).toContain("sk_intake_replacement_fixture");
  });

  it("requires an explicit acknowledgement to configure an existing trusted definition", async () => {
    const copy = en.crmPage.operations;
    const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label)!;
    expect(host.textContent).toContain(copy.verificationUnconfigured);
    await act(async () => button(copy.editDefinition).click());
    const input = (label: string) => Array.from(host.querySelectorAll("label")).find((item) => item.querySelector("span")?.textContent === label)?.querySelector("input")!;
    expect(input(copy.definitionKey).disabled).toBe(true);
    expect(button(copy.saveDefinitionVersion).disabled).toBe(true);
    await act(async () => {
      setInput(input(copy.verificationKeyId), "fixture_key");
      setInput(input(copy.verificationPublicKey), "A".repeat(43));
      setInput(input(copy.verificationMaxAge), "600");
    });
    expect(button(copy.saveDefinitionVersion).disabled).toBe(true);
    await act(async () => input(copy.verificationAcknowledgement).click());
    expect(button(copy.saveDefinitionVersion).disabled).toBe(false);
    await act(async () => button(copy.saveDefinitionVersion).click());
    await settle();
    expect(api.saveCrmIntakeDefinition).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      definitionId: definition.id, definitionKey: definition.definitionKey, expectedVersion: 2,
      definition: expect.objectContaining({ identityPolicy: "trusted_verified_email", queueKey: definition.queueKey,
        consentMappings: definition.consentMappings, identityVerification: { keyId: "fixture_key", publicKey: "A".repeat(43), maxAgeSeconds: 600, acknowledged: true } }),
    }));
  });

  it("shows the configuration blocker when the acknowledging member is unavailable", async () => {
    api.listCrmIntakeDefinitions.mockResolvedValue([{ ...definition,
      identityVerification: { keyId: "fixture_key", publicKey: "A".repeat(43), maxAgeSeconds: 600, acknowledged: true },
      verificationAcknowledgedByUserId: null,
    }]);
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><CrmIntakeSettings workspaceId="workspace-2" /></I18nProvider>));
    await settle();
    expect(host.textContent).toContain(en.crmPage.operations.verificationUnconfigured);
  });

});
