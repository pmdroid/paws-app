import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createCloseoutSettings, type CloseoutSummaryEntry } from "./closeout-settings";
import { renderSettingsPage, setSettingsAdmin, WORKSPACE_PAGES } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const ENGINE = "http://127.0.0.1:8787";
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
let window: Window;
let paths: string[];

const SUMMARY: CloseoutSummaryEntry[] = [
  {
    repository: "acme/web",
    commit: COMMIT,
    rerun: { conflict: { run: ["lint"], reviews: false }, ci: { run: "failed" } },
    checks: [
      { id: "lint", ci: "lint" },
      {
        id: "test",
        ci: "test*",
        select: {
          runner: "bun",
          always: ["test/a.test.ts"],
          full_on: ["bun.lock"],
          max_selected: 120,
        },
      },
    ],
  },
  {
    repository: "acme/api",
    commit: COMMIT,
    rerun: null,
    checks: [{ id: "test", since: ["bun", "test", "{since}"] }],
  },
  {
    repository: "acme/bad",
    commit: COMMIT,
    error: "/rerun/ci/run must be equal to one of the allowed values",
  },
];

beforeEach(() => {
  window = new Window({ url: `${ENGINE}/dashboard/workspace/closeout` });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  paths = [];
  globalThis.fetch = (async (url: URL | string) => {
    paths.push(new URL(url).pathname);
    return Response.json({ repositories: SUMMARY });
  }) as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  setSettingsAdmin(false);
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
});

test("Closeout follows Repositories and only admins get its page", () => {
  const ids = WORKSPACE_PAGES.map((page) => page.id);
  expect(ids.indexOf("closeout")).toBe(ids.indexOf("repositories") + 1);
  setSettingsAdmin(false);
  expect(renderSettingsPage("closeout")).not.toContain("closeout-settings");
  setSettingsAdmin(true);
  expect(renderSettingsPage("closeout")).toContain('id="closeout-settings"');
});

test("the page shows a card per repository from the summary alone", async () => {
  setSettingsAdmin(true);
  const doc = window.document;
  doc.body.innerHTML = renderSettingsPage("closeout");
  createCloseoutSettings().mount(
    doc.querySelector("#closeout-settings") as unknown as HTMLElement,
    ENGINE,
  );
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await settleReactWork();
  expect(paths).toEqual(["/api/settings/closeout-summary"]);

  const web = doc.querySelector('[data-closeout-repo="acme/web"]')!;
  expect(web.textContent).toContain("at main 0123456");
  expect(web.querySelector("a")?.getAttribute("href")).toBe(
    `https://github.com/acme/web/blob/${COMMIT}/.agents/closeout.yaml`,
  );
  const columns = [...web.querySelectorAll("[data-reruns] > *")].map((node) => node.textContent);
  expect(columns[0]).toContain("lint runs");
  expect(columns[0]).toContain("test kept");
  expect(columns[0]).toContain("Reviews are skipped");
  expect(columns[1]).toContain("Only the check the failed CI job belongs to runs again");
  expect(columns[1]).toContain("test*");
  expect(columns[2]).toContain("The whole plan runs");
  const cells = [...web.querySelectorAll("[data-select] tbody td")].map((cell) => cell.textContent);
  expect(cells).toEqual(["test", "bun", "Test file", "test/a.test.ts", "bun.lock", "120"]);

  const api = doc.querySelector('[data-closeout-repo="acme/api"]')!;
  expect(api.textContent).toContain("Reruns everything");
  expect(api.textContent).toContain("run: [test]");
  expect(api.textContent).toContain("No check narrows its tests");
  expect(api.textContent).toContain("runner: bun");

  const bad = doc.querySelector('[data-closeout-error="acme/bad"]')!;
  expect(bad.className).toContain("border-state-failed");
  expect(bad.textContent).toContain("must be equal to one of the allowed values");
  expect(bad.textContent).toContain("Closeout reruns everything until it's fixed.");
});
