import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createBriefSettings } from "./brief-settings";
import { createHookSettings, type HookListing } from "./hooks";
import { parseRoute } from "./route";
import { SETTINGS_PAGES, renderSettingsPage } from "./settings-pages";
import { createSkillSettings, type SkillListing } from "./skills";
import { settleReactWork } from "./settle-react";

const MOVED = ["brief-settings", "skill-settings", "hook-settings"];

test("the settings navigation has no Decisions page and opens on Agents", () => {
  expect(SETTINGS_PAGES.map((page) => page.id)).not.toContain("decisions");
  expect(SETTINGS_PAGES.map((page) => page.name)).not.toContain("Decisions");
  expect(SETTINGS_PAGES[0]?.id).toBe("agents");
  expect(parseRoute("/settings")).toEqual({ view: "settings" });
  expect(parseRoute("/settings/decisions")).toEqual({ view: "settings" });
  expect(renderSettingsPage()).toContain('aria-current="page" class="settings-link">Agents</a>');
});

test("Agent instructions holds the brief, then skills, then hooks", () => {
  expect(SETTINGS_PAGES.find((page) => page.id === "brief")).toEqual({
    id: "brief",
    name: "Agent instructions",
    description: "What coding agents are told: the brief, skills and hooks.",
  });
  const html = renderSettingsPage("brief");
  expect(html).toContain(
    '<p class="sub">What coding agents are told: the brief, skills and hooks.</p>',
  );
  const order = MOVED.map((id) => html.indexOf(`id="${id}"`));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("settings shows one tab bar of nine pages in order, marking the current one", () => {
  const doc = new Window().document;
  doc.body.innerHTML = renderSettingsPage("merging");
  const navs = doc.querySelectorAll("nav");
  expect(navs.length).toBe(1);
  expect(navs[0]?.getAttribute("aria-label")).toBe("Settings pages");
  const links = [...navs[0]!.querySelectorAll("a")];
  expect(links.map((link) => link.textContent)).toEqual([
    "Agents",
    "Merging",
    "Queue and limits",
    "Agent instructions",
    "Integrations",
    "Members",
    "Workspace access",
    "Your account",
    "Audit history",
  ]);
  for (const [index, link] of links.entries()) {
    const id = SETTINGS_PAGES[index]!.id;
    expect(link.getAttribute("href")?.endsWith(`/settings/${id}`)).toBe(true);
    expect(parseRoute(new URL(link.getAttribute("href")!, ENGINE).pathname)).toEqual({
      view: "settings",
      page: id,
    });
  }
  const current = links.filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.map((link) => link.textContent)).toEqual(["Merging"]);
  expect(doc.body.textContent).not.toMatch(/\badmin\b|\byou\b|When to touch this/);
  expect(doc.querySelector(".settings-when, h1")).toBeNull();
  expect(doc.querySelector(".settings-body > p.sub")?.textContent).toBe(
    SETTINGS_PAGES[1]!.description,
  );
});

test("the Agents page holds no brief, skills or hooks", () => {
  const html = renderSettingsPage("agents");
  for (const id of MOVED) expect(html).not.toContain(`id="${id}"`);
  expect(html).toContain('id="agent-settings"');
});

const BRIEF = {
  template: "Workspace",
  defaultTemplate: "Built-in",
  placeholders: [],
  projects: [],
};
const SKILLS: SkillListing = {
  agents: ["claude"],
  limitBytes: 1024,
  skills: [
    {
      name: "polish",
      source: { kind: "npm", package: "polish" },
      version: "1.0.0",
      sha256: "a".repeat(64),
      sizeBytes: 512,
      agents: ["claude"],
      removedAt: null,
    },
  ],
};
const HOOKS: HookListing = {
  events: [{ id: "after_edit", label: "After a file edit" }],
  agents: ["claude"],
  skills: [],
  limit: 20,
  hooks: [
    {
      id: "hook_fmt",
      event: "after_edit",
      matcher: null,
      command: "bun run fmt",
      timeoutSeconds: 60,
      agents: ["claude"],
      skill: null,
    },
  ],
};
const ENGINE = "http://127.0.0.1:8787";
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event", "confirm"] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;
let requests: { method: string; path: string }[];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  window = new Window({ url: `${ENGINE}/settings/brief` });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window"
        ? window
        : name === "confirm"
          ? () => true
          : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push({ method: init.method ?? "GET", path });
    return Response.json(
      path.endsWith("/brief") ? BRIEF : path.endsWith("/skills") ? SKILLS : HOOKS,
    );
  }) as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

test("the brief, skills and hooks load and save from Agent instructions", async () => {
  window.document.body.innerHTML = renderSettingsPage("brief");
  const root = (id: string) => window.document.querySelector(`#${id}`) as unknown as HTMLElement;
  createBriefSettings().mount(root("brief-settings"), ENGINE);
  createSkillSettings().mount(root("skill-settings"), ENGINE);
  createHookSettings().mount(root("hook-settings"), ENGINE);
  await settle();
  expect(requests).toEqual([
    { method: "GET", path: "/api/settings/brief" },
    { method: "GET", path: "/api/settings/skills" },
    { method: "GET", path: "/api/settings/hooks" },
  ]);
  requests = [];
  for (const button of ['[data-brief="save"]', '[data-skill="remove"]', '[data-hook="remove"]']) {
    (window.document.querySelector(button) as unknown as HTMLButtonElement).click();
    await settle();
  }
  expect(requests).toEqual([
    { method: "PUT", path: "/api/settings/brief" },
    { method: "POST", path: "/api/settings/skills" },
    { method: "POST", path: "/api/settings/hooks" },
  ]);
});
