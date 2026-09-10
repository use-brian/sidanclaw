import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { syncChannelSlashCommands } from "../channels";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("syncChannelSlashCommands", () => {
  it.each(["PUBLIC_API_URL", "NEXT_PUBLIC_API_URL"])("uses the configured hosted API via %s", async (name) => {
    vi.stubEnv(name, "https://api.usebrian.ai");
    vi.resetModules();
    const { authFetch: hostedFetch } = await import("@/lib/auth-fetch");
    const { syncChannelSlashCommands: hostedSync } = await import("../channels");
    vi.mocked(hostedFetch).mockResolvedValue(new Response(JSON.stringify({ commandCount: 1, omittedCount: 0 })));

    await hostedSync("workspace/one", "channel/two");

    expect(hostedFetch).toHaveBeenCalledWith(
      "https://api.usebrian.ai/api/workspaces/workspace%2Fone/channels/channel%2Ftwo/slash-commands/sync",
      { method: "POST" },
    );
  });

  it("POSTs to the same-origin encoded channel route and parses the receipt", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ commandCount: 7, omittedCount: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      syncChannelSlashCommands("workspace/one", "channel/two"),
    ).resolves.toEqual({ commandCount: 7, omittedCount: 2 });
    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace%2Fone/channels/channel%2Ftwo/slash-commands/sync",
      { method: "POST" },
    );
  });

  it("surfaces the API detail and falls back to the response status", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "provider_rejected_commands",
          detail: "Telegram rejected the command list",
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(syncChannelSlashCommands("ws", "channel")).rejects.toThrow(
      "Telegram rejected the command list",
    );

    mockAuthFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(null), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(syncChannelSlashCommands("ws", "channel")).rejects.toThrow(
      "Slash command sync failed (503)",
    );
  });

  it("rejects a malformed success receipt", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ commandCount: 3, omittedCount: -1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(syncChannelSlashCommands("ws", "channel")).rejects.toThrow(
      "Slash command sync returned an invalid response",
    );
  });
});
