import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("[COMP:app-desktop/packaging] desktop packaging", () => {
  it("builds the desktop renderer's workspace dependencies before Vite", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["build:renderer"]).toBe(
      'pnpm --filter "app-web^..." run build && pnpm --filter app-web build:desktop',
    );
  });
});
