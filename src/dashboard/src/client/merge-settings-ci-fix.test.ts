import { setSettingsAdmin } from "./settings-pages";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { AgentSettings } from "../agent-settings";
import type { MergeSettingsView } from "../merge-settings";
import { createMergeSettings } from "./merge-settings";
import { settleReactWork } from "./settle-react";

const MERGING: MergeSettingsView = {
  default: { order: "queue", mainMoved: "overlap" },
};
const AGENTS: AgentSettings = {
  defaults: {
    implementer: { agent: "claude", model: null },
    reviewer: { agent: "codex", model: "gpt-5.4" },
  },
  revision: "rev-1",
  queue: { startTimeoutHours: 24, maxRunningPerOwner: null },
};

let window: Window;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
let requests: { url: string; method: string; body: unknown }[];
let stored: number | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  setSettingsAdmin(true);
  window = new Window({ url: "http://127.0.0.1:8787/settings/merging" });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  stored = undefined;
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: path, method, body });
    if (path === "/api/settings/merging") return Response.json(body ?? MERGING);
    if (method === "PUT") stored = body.merge.ciFixAttempts;
    return Response.json({
      ...AGENTS,
      ...(stored === undefined ? {} : { merge: { ciFixAttempts: stored } }),
    });
  }) as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

function mount(): HTMLElement {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(root as never);
  createMergeSettings(() => {}).mount(root, "http://127.0.0.1:8787");
  return root;
}

function setValue(root: HTMLElement, name: string, value: string) {
  const field = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
}

function submit(root: HTMLElement) {
  root
    .querySelector("#merge-settings-form")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
}

test("Merging saves CI fix attempts with the agent settings, as the Agents page did", async () => {
  const root = mount();
  await settle();
  expect(requests.map(({ url, method }) => `${method} ${url}`).sort()).toEqual([
    "GET /api/settings/agents",
    "GET /api/settings/merging",
  ]);
  expect(root.querySelector<HTMLInputElement>('[name="merge-ci-fix-attempts"]')!.value).toBe("3");
  setValue(root, "merge-ci-fix-attempts", "5");
  submit(root);
  await settle();
  const writes = requests.slice(2).filter(({ method }) => method === "PUT");
  expect(writes.map(({ url }) => url)).toEqual(["/api/settings/agents", "/api/settings/merging"]);
  expect(writes[0]!.body).toEqual({ ...AGENTS, merge: { ciFixAttempts: 5 } });
  expect(writes[1]!.body).not.toHaveProperty("merge");
  expect(root.querySelector<HTMLInputElement>('[name="merge-ci-fix-attempts"]')!.value).toBe("5");
  expect(root.innerHTML).toContain("Merging settings saved.");
});

test("an unchanged count leaves the agent settings alone, and an invalid one saves nothing", async () => {
  const root = mount();
  await settle();
  submit(root);
  await settle();
  expect(requests.filter(({ method }) => method === "PUT").map(({ url }) => url)).toEqual([
    "/api/settings/merging",
  ]);
  const before = requests.length;
  setValue(root, "merge-ci-fix-attempts", "11");
  submit(root);
  await settle();
  expect(requests.length).toBe(before);
  const input = root.querySelector('[name="merge-ci-fix-attempts"]')!;
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(root.querySelector("#merge-ci-fix-attempts-error")!.textContent).toBe(
    "CI fix attempts: enter a whole number from 0 to 10.",
  );
});

test("repository and project drafts survive server validation and then save", async () => {
  const original = globalThis.fetch;
  let invalid = true;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/api/settings/merging")) {
      if (init?.method === "PUT") {
        if (invalid)
          return Response.json({ error: "reviewApps must be a GitHub App slug" }, { status: 400 });
        return original(url, init);
      }
      return Response.json({
        ...MERGING,
        repositories: { "acme/app": { packages: ["apps/*"], reviewApps: [] } },
        projects: { abc: { lane: "repository" } },
      });
    }
    return original(url, init);
  }) as typeof fetch;
  const root = mount();
  await settle();
  setValue(root, "repo-apps-0", "bad slug");
  setValue(root, "project-lane-0", "project");
  submit(root);
  await settle();
  expect(root.textContent).toContain("reviewApps must be a GitHub App slug");
  expect(root.querySelector<HTMLTextAreaElement>("#repo-apps-0")!.value).toBe("bad slug");
  invalid = false;
  setValue(root, "repo-apps-0", "review-bot");
  submit(root);
  await settle();
  expect(requests.find((request) => request.method === "PUT")?.body).toMatchObject({
    repositories: { "acme/app": { packages: ["apps/*"], reviewApps: ["review-bot"] } },
    projects: { abc: { lane: "project" } },
  });
});

test("the conflict hold switch and rule save from the form, and an out-of-range number saves nothing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/api/settings/merging") && init?.method !== "PUT") {
      requests.push({ url: "/api/settings/merging", method: "GET", body: undefined });
      return Response.json({
        ...MERGING,
        overlapHold: true,
        conflictProneAfter: 2,
        conflictProneDays: 7,
        parallelFiles: [],
        hotFiles: [
          { repository: "acme/app", path: "src/a.ts", conflicts: 2, items: [], held: true },
        ],
      });
    }
    return original(url, init);
  }) as typeof fetch;
  const root = mount();
  await settle();
  const hold = root.querySelector<HTMLInputElement>('[name="overlap-hold"]')!;
  hold.checked = false;
  hold.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  expect(root.querySelector<HTMLInputElement>('[name="hot-hold"]')!.disabled).toBe(true);
  expect(root.querySelector<HTMLInputElement>('[name="hot-hold"]')!.checked).toBe(true);
  setValue(root, "merge-conflict-prone-days", "31");
  submit(root);
  await settle();
  expect(requests.filter(({ method }) => method === "PUT")).toEqual([]);
  expect(root.querySelector("#merge-conflict-prone-days-error")!.textContent).toBe(
    "Must be a whole number from 1 to 30",
  );
  setValue(root, "merge-conflict-prone-after", "4");
  setValue(root, "merge-conflict-prone-days", "14");
  submit(root);
  await settle();
  expect(requests.find(({ method }) => method === "PUT")?.body).toMatchObject({
    overlapHold: false,
    conflictProneAfter: 4,
    conflictProneDays: 14,
    parallelFiles: [],
  });
});
