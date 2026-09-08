/**
 * Audit session list (docs/architecture/features/chat-audit.md → "Session
 * list"). The row rendering is FE/gstack-QA territory; the one rule with a
 * wire contract behind it - how a session's `channel_type` folds onto the
 * labelled channel set the dictionary carries - is pinned here so a new
 * channel type can never render an unlabelled row.
 */

import { describe, expect, it } from "vitest";
import { auditChannelKey } from "../audit-session-list";
import { en } from "@/lib/i18n/dictionaries/en";

describe("[COMP:app-web/brain-audit] auditChannelKey", () => {
  it("folds every known channel_type onto a labelled key", () => {
    expect(auditChannelKey("web")).toBe("web");
    expect(auditChannelKey("notification")).toBe("web");
    expect(auditChannelKey("telegram")).toBe("telegram");
    expect(auditChannelKey("slack")).toBe("slack");
    expect(auditChannelKey("discord")).toBe("discord");
    expect(auditChannelKey("whatsapp")).toBe("whatsapp");
    expect(auditChannelKey("wechat")).toBe("wechat");
    expect(auditChannelKey("msteams")).toBe("msteams");
    expect(auditChannelKey("email")).toBe("email");
    expect(auditChannelKey("agentmail")).toBe("email");
    expect(auditChannelKey("imap")).toBe("email");
  });

  it("sends an unknown channel to the generic label instead of an empty row", () => {
    expect(auditChannelKey("carrier-pigeon")).toBe("other");
    expect(auditChannelKey("")).toBe("other");
  });

  it("every key it can return has copy in the dictionary", () => {
    const keys = ["web", "telegram", "slack", "discord", "whatsapp", "wechat", "msteams", "email", "other"];
    for (const key of keys) {
      expect(typeof en.brainPage.audit.channel[key as keyof typeof en.brainPage.audit.channel]).toBe("string");
    }
  });
});
