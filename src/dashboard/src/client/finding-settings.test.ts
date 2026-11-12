import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { FindingGroupsResponse } from "../finding-groups";
import { createFindings } from "./findings";
import { matchRoute } from "./route";
import { SETTINGS_PAGES, renderSettingsPage } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const ENGINE = "http://127.0.0.1:8787";
const GLOBALS = [
  "window",
  "document",
  "location",
  "history",
  "HTMLInputElement",
  "HTMLSelectElement",
  "Event",
] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
let window: Window;
let requests: { method: string; path: string; body: unknown }[];
let groups: FindingGroupsResponse;

beforeEach(() => {
  window = new Window({ url: `${ENGINE}/dashboard/findings` });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  groups = {
    groups: [],
    lastRun: {
      id: "run-1",
      startedAt: Date.UTC(2026, 10, 12, 6, 0),
      finishedAt: Date.UTC(2026, 10, 12, 6, 1),
      status: "completed",
      tokens: 10,
      groupCount: 0,
      error: null,
    },
    canRun: true,
    canChange: true,
    enabled: true,
  };
  globalThis.fetch = (async (url: URL | string, init: RequestInit = {}) => {
    const target = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method: init.method ?? "GET", path: target.pathname, body });
    if (target.pathname === "/api/settings/findings") {
      groups = { ...groups, enabled: body.grouping };
      return Response.json({ grouping: body.grouping, groupingTime: "06:00" });
    }
    if (target.pathname === "/api/finding-groups") return Response.json(groups);
    return Response.json({ findings: [], total: 0, counts: {}, repositories: [], reviews: [] });
  }) as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

async function mount(): Promise<HTMLElement> {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(root as never);
  createFindings().mount(root, ENGINE, "live");
  await settle();
  await settle();
  return root;
}

const grouping = (root: HTMLElement) =>
  root.querySelector<HTMLInputElement>('[name="finding-grouping"]')!;

test("the Findings page shows the grouping switch and saves through the settings API", async () => {
  const root = await mount();
  expect(root.innerHTML.indexOf("finding-grouping")).toBeLessThan(
    root.innerHTML.indexOf("Findings view"),
  );
  expect(root.textContent).toContain("Group similar findings into suggested fixes once a day");
  expect(root.textContent).toContain("Last run 2026-11-12 06:00 UTC");
  expect(grouping(root).checked).toBe(true);
  expect(grouping(root).disabled).toBe(false);
  grouping(root).checked = false;
  grouping(root).dispatchEvent(new window.Event("change", { bubbles: true }) as never);
  await settle();
  await settle();
  expect(requests.find((r) => r.method === "POST")).toEqual({
    method: "POST",
    path: "/api/settings/findings",
    body: { grouping: false },
  });
  expect(grouping(root).checked).toBe(false);
  expect(root.textContent).toContain("Daily grouping is off.");
});

test("a member sees the grouping state read-only", async () => {
  groups = { ...groups, canRun: false, canChange: false };
  const root = await mount();
  expect(grouping(root).checked).toBe(true);
  expect(grouping(root).disabled).toBe(true);
  expect(root.textContent).toContain("Only workspace admins can change this.");
});

test("Settings no longer lists Findings and its old path opens the Findings page", () => {
  expect(SETTINGS_PAGES.map((page) => page.id)).not.toContain("findings");
  expect(renderSettingsPage("agents")).not.toContain("/settings/findings");
  expect(matchRoute("/settings/findings")).toEqual({ view: "findings" });
});
