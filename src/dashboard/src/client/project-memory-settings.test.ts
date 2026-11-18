import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { AgentSettings } from "../agent-settings";
import {
  WORKSPACE_PAGES,
  renderSettingsPage,
  setSettingsAdmin,
  settingsRedirect,
} from "./settings-pages";
import { createProjectMemorySettings } from "./project-memory-settings";
import { settleReactWork } from "./settle-react";

const STORED: AgentSettings = {
  defaults: {
    implementer: { agent: "claude", model: null },
    reviewer: { agent: "codex", model: null },
  },
  merge: { ciFixAttempts: 3 },
  projectMemory: { workSummary: true, dream: false, decisions: true },
  revision: "r1",
};

let window: Window;
const realFetch = globalThis.fetch;
const saved = new Map<string, unknown>();
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
let requests: { url: string; init: RequestInit }[];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  setSettingsAdmin(true);
  window = new Window({ url: "http://127.0.0.1:8787/workspace/project-memory" });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    requests.push({ url: String(url), init });
    const body = init.body ? JSON.parse(String(init.body)) : STORED;
    return Response.json(init.body ? { ...STORED, ...body, revision: "r2" } : body);
  }) as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

const switchFor = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLInputElement>(`input[role="switch"][name="${name}"]`)!;

test("Project memory follows Agents and holds its settings", () => {
  const ids = WORKSPACE_PAGES.map((page) => page.id);
  expect(ids.indexOf("project-memory")).toBe(ids.indexOf("agents") + 1);
  expect(WORKSPACE_PAGES.find((page) => page.id === "project-memory")?.name).toBe("Project memory");
  expect(renderSettingsPage("project-memory")).toContain('id="project-memory-settings"');
});

test("members don't see the Project memory page", () => {
  setSettingsAdmin(false);
  const html = renderSettingsPage("project-memory");
  expect(html).not.toContain("project-memory-settings");
  expect(html).toContain("<h1>Your account</h1>");
  expect(settingsRedirect("/workspace/project-memory")).toBe("/settings/account");
});

test("the switches show the stored values, and toggling and saving sends the PUT", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  let savedCount = 0;
  createProjectMemorySettings(() => savedCount++).mount(root, "http://127.0.0.1:8787");
  await settle();
  const checked = () =>
    ["decisions", "workSummary", "dream"].map((name) => switchFor(root, name).checked);
  expect(checked()).toEqual([true, true, false]);
  expect(root.textContent).toContain("With all off, agents see only titles of what's stored");
  for (const name of ["dream", "decisions"]) {
    const field = switchFor(root, name);
    field.checked = !field.checked;
    field.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  }
  root
    .querySelector("#project-memory-form")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
  await settle();
  await settle();
  const put = requests.at(-1)!;
  expect([put.init.method, put.url]).toEqual(["PUT", "http://127.0.0.1:8787/api/settings/agents"]);
  expect((put.init.headers as Record<string, string>)["x-paws-csrf"]).toBe("token-1");
  const { merge: _merge, ...agents } = STORED;
  expect(JSON.parse(String(put.init.body))).toEqual({
    ...agents,
    projectMemory: { workSummary: true, dream: true, decisions: false },
  });
  expect(savedCount).toBe(1);
  expect(root.textContent).toContain("Saved.");
  expect(checked()).toEqual([false, true, true]);
});
