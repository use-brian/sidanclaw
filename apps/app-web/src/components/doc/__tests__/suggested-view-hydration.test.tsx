// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionaries";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api/views", () => ({
  listWorkspaceAssistants: async () => [],
}));
vi.mock("@/components/doc/suggested-file-drop", () => ({ SuggestedFileDrop: () => null }));
vi.mock("../doc-sidebar-data", () => ({
  useSidebarData: () => ({ dock: null, dockLoading: true, reloadDock: vi.fn(), setDock: vi.fn() }),
}));

import { SuggestedView } from "../suggested-view";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("[COMP:app-web/home-suggested] Header hydration", () => {
  it.each([
    ["en", "en", 0, "greetingMorning"],
    ["ja", "ja", 11, "greetingMorning"],
    ["zh", "zh-TW", 12, "greetingAfternoon"],
    ["zh-CN", "zh-CN", 18, "greetingEvening"],
  ] as const)("hydrates %s across runtime locale, timezone and clock differences", async (locale, intlLocale, hour, greetingKey) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T23:59:59Z"));
    let runtimeLocale = "en-US";
    let timeZone = "UTC";
    const formatDate = vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, locales, options) {
      return new Intl.DateTimeFormat(locales ?? runtimeLocale, { ...options, timeZone }).format(this);
    });
    const getHours = vi.spyOn(Date.prototype, "getHours").mockReturnValue(23);
    const view = (language: Locale) => (
      <StrictMode>
        <I18nProvider locale={language} dict={getDictionary(language)}>
          <SuggestedView workspaceId="workspace-test" userName="Reader" />
        </I18nProvider>
      </StrictMode>
    );
    container = document.createElement("div");
    container.innerHTML = renderToString(view(locale));
    document.body.appendChild(container);
    const heading = container.querySelector("h1")!;
    const date = heading.previousElementSibling!;
    expect(heading.textContent).toBe("");
    expect(date.textContent).toBe("");
    expect(formatDate).not.toHaveBeenCalled();
    expect(getHours).not.toHaveBeenCalled();

    // Simulate a different browser default locale/timezone and a midnight crossing.
    runtimeLocale = "en-GB";
    timeZone = "Asia/Tokyo";
    vi.setSystemTime(new Date("2026-01-16T00:00:01Z"));
    getHours.mockReturnValue(hour);
    const onRecoverableError = vi.fn();
    await act(async () => {
      root = hydrateRoot(container!, view(locale), { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.querySelector("h1")).toBe(heading);
    expect(heading.textContent).toBe(`${getDictionary(locale).docPage.suggested[greetingKey]}, Reader`);
    expect(date.textContent).toBe(new Intl.DateTimeFormat(intlLocale, {
      weekday: "long", month: "long", day: "numeric", timeZone,
    }).format(new Date()));
    expect(formatDate).toHaveBeenLastCalledWith(intlLocale, {
      weekday: "long", month: "long", day: "numeric",
    });

    // Subsequent renders still refresh local time and honor a changed app locale.
    vi.setSystemTime(new Date("2026-01-17T00:00:01Z"));
    getHours.mockReturnValue(18);
    await act(async () => root!.render(view("ja")));
    expect(heading.textContent).toBe(`${getDictionary("ja").docPage.suggested.greetingEvening}, Reader`);
    expect(date.textContent).toBe(new Intl.DateTimeFormat("ja", {
      weekday: "long", month: "long", day: "numeric", timeZone,
    }).format(new Date()));
    expect(onRecoverableError).not.toHaveBeenCalled();
  });
});
