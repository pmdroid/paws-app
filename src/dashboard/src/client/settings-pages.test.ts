import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createBriefSettings } from "./brief-settings";
import { createHookSettings, type HookListing } from "./hooks";
import { render } from "./render";
import { parseRoute } from "./route";
import {
  SETTINGS_PAGES,
  USER_SETTINGS_PAGES,
  WORKSPACE_PAGES,
  renderSettingsPage,
  setSettingsAdmin,
  settingsRedirect,
} from "./settings-pages";
import { createSkillSettings, type SkillListing } from "./skills";
import { settleReactWork } from "./settle-react";
import { initializeWorkspaceAccess } from "./workspace";

const MOVED = ["brief-settings", "skill-settings", "hook-settings"];

test("Settings opens on Your account and Workspace opens on Agents", () => {
  setSettingsAdmin(true);
  expect(SETTINGS_PAGES.map((page) => page.id)).not.toContain("decisions");
  expect(SETTINGS_PAGES.map((page) => page.name)).not.toContain("Decisions");
  expect(parseRoute("/settings")).toEqual({ view: "settings" });
  expect(parseRoute("/settings/decisions")).toEqual({ view: "settings" });
  expect(parseRoute("/workspace")).toEqual({ view: "workspace" });
  expect(
    render({ route: { view: "settings" }, phase: "ready", error: null, engineUrl: ENGINE }).content,
  ).toContain("<h1>Your account</h1>");
  expect(
    render({ route: { view: "workspace" }, phase: "ready", error: null, engineUrl: ENGINE })
      .content,
  ).toContain("<h1>Agents</h1>");
});

test("an old settings link to a workspace page opens Workspace for admins and Your account for members", () => {
  setSettingsAdmin(true);
  expect(settingsRedirect("/settings/merging")).toBe("/workspace/merging");
  expect(settingsRedirect("/settings/account")).toBeNull();
  expect(settingsRedirect("/workspace/merging")).toBeNull();
  setSettingsAdmin(false);
  expect(settingsRedirect("/settings/merging")).toBe("/settings/account");
  expect(settingsRedirect("/workspace/merging")).toBe("/settings/account");
  expect(settingsRedirect("/workspace")).toBe("/settings/account");
  expect(settingsRedirect("/settings/agent-accounts")).toBeNull();
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

test("every Settings and Workspace page shows its title and description with no tab bar", () => {
  setSettingsAdmin(true);
  for (const page of SETTINGS_PAGES) {
    const doc = new Window().document;
    doc.body.innerHTML = renderSettingsPage(page.id);
    expect(doc.querySelectorAll("nav").length).toBe(0);
    expect(doc.querySelector("h1")?.textContent).toBe(page.name);
    expect(doc.querySelector(".settings-body > p.sub")?.textContent).toBe(page.description);
  }
});

test("a member opening a workspace page gets Your account", () => {
  setSettingsAdmin(false);
  const account = USER_SETTINGS_PAGES.find((entry) => entry.id === "account")!;
  for (const page of WORKSPACE_PAGES) {
    const doc = new Window().document;
    doc.body.innerHTML = renderSettingsPage(page.id);
    expect(doc.querySelectorAll("nav").length).toBe(0);
    expect(doc.querySelector("h1")?.textContent).toBe(account.name);
    expect(doc.querySelector(".settings-body")?.innerHTML).toBe(
      `<p class="sub">${account.description}</p>`,
    );
  }
  const route = { view: "workspace", page: "merging" } as const;
  expect(render({ route, phase: "ready", error: null, engineUrl: ENGINE }).title).toBe(
    "Paws status · Your account",
  );
  setSettingsAdmin(true);
  expect(render({ route, phase: "ready", error: null, engineUrl: ENGINE }).title).toBe(
    "Paws status · Merging",
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
  setSettingsAdmin(true);
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

test("Workspace pages show only once the session says admin", async () => {
  for (const role of ["admin", "member"]) {
    let respond = (_: Response) => {};
    globalThis.fetch = (() =>
      new Promise((resolve) => (respond = resolve))) as unknown as typeof fetch;
    const loaded = initializeWorkspaceAccess(() => null);
    window.document.body.innerHTML = renderSettingsPage("merging");
    expect(window.document.querySelector("h1")?.textContent).toBe("Your account");
    respond(Response.json({ role, workspaceId: "w", csrfToken: "t", workspaces: [] }));
    expect(await loaded).toBe(true);
    window.document.body.innerHTML = renderSettingsPage("merging");
    expect(window.document.querySelector("h1")?.textContent).toBe(
      role === "admin" ? "Merging" : "Your account",
    );
  }
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
