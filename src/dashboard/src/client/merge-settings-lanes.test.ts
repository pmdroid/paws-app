import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { MergeSettingsView } from "../merge-settings";
import { createMergeSettings, laneNames } from "./merge-settings";
import { settleReactWork } from "./settle-react";

const MERGING: MergeSettingsView = {
  default: { order: "queue", mainMoved: "overlap" },
  lanes: ["project"],
  noProject: "own",
  parallel: 3,
};
const AT = "2026-11-13T14:00:00.000Z";
const ISSUES = [
  ["PAS-1", "Ada", "Billing"],
  ["PAS-2", "Ben", "Billing"],
  ["PAS-3", "Ada", "Search"],
  ["PAS-4", "Ada", null],
  ["PAS-5", "Ben", "Inbox"],
] as const;
const QUEUE = {
  source: "live",
  generatedAt: AT,
  project: { name: "Paws", team: "PAS", repo: "acme/paws", workspace: null },
  entries: ISSUES.map(([itemId], index) => ({
    ...{ position: index + 1, itemId, repository: "acme/paws", enqueuedAt: AT, acceptedAt: AT },
    ...{ waitingFor: "ahead", detail: null, steps: [] },
    settings: { order: "queue", mainMoved: "overlap", rule: null },
  })),
  issues: ISSUES.map(([id, owner, name]) => ({
    ...{ id, title: id, owner, pr: null },
    project: name && { id: name, name },
  })),
  ...{ history: [], pushOutages: [], policyRunnerWarnings: [] },
};

let window: Window;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
let puts: unknown[];
let status: number;
let queueReady: Promise<unknown>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  window = new Window({
    url: "http://127.0.0.1:8787/settings/merging",
    width: 375,
    height: 812,
  });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  puts = [];
  status = 200;
  queueReady = Promise.resolve();
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (status !== 200) return Response.json({ error: "Workspace administration" }, { status });
    if (path === "/api/merge-queue") return queueReady.then(() => Response.json(QUEUE));
    if (path === "/api/settings/merging") {
      if (init.method !== "PUT") return Response.json(MERGING);
      const body = JSON.parse(String(init.body));
      puts.push(body);
      return Response.json(body);
    }
    return Response.json({ defaults: {}, revision: "rev-1" });
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
  createMergeSettings(() => {}).mount(root, "http://127.0.0.1:8787");
  await settle();
  await settle();
  return root;
}

function field<T extends HTMLElement = HTMLInputElement>(root: HTMLElement, selector: string): T {
  return root.querySelector<T>(selector)!;
}

function change(element: HTMLElement) {
  element.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
}

function submit(root: HTMLElement) {
  root
    .querySelector("#merge-settings-form")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
}

test("each lane control reads its setting from the settings API", async () => {
  const root = await mount();
  const section = field<HTMLElement>(root, "#merge-lanes");
  const repository = field(root, '[name="lane-repository"]');
  expect([repository.checked, repository.disabled]).toEqual([true, true]);
  expect(field(root, '[name="lane-project"]').checked).toBe(true);
  expect(field(root, '[name="lane-person"]').checked).toBe(false);
  expect(field(root, '[name="lane-no-project"]:checked').value).toBe("own");
  expect(field<HTMLSelectElement>(root, '[name="merge-parallel"]').value).toBe("3");
  const batch = field(root, '[name="merge-batch-check"]');
  expect([batch.checked, batch.disabled]).toEqual([true, true]);
  for (const text of ["Merge lanes", "Give each lane its own", "One lane, like a project"])
    expect(section.textContent).toContain(text);
});

test("each lane control saves its setting through the settings API", async () => {
  const root = await mount();
  const person = field(root, '[name="lane-person"]');
  person.checked = true;
  change(person);
  const project = field(root, '[name="lane-project"]');
  project.checked = false;
  change(project);
  const lane = field(root, '[name="lane-no-project"][value="lane"]');
  lane.checked = true;
  change(lane);
  const parallel = field<HTMLSelectElement>(root, '[name="merge-parallel"]');
  parallel.value = "5";
  change(parallel);
  submit(root);
  await settle();
  expect(puts).toEqual([
    { default: MERGING.default, lanes: ["person"], noProject: "lane", parallel: 5 },
  ]);
  expect(field<HTMLSelectElement>(root, '[name="merge-parallel"]').value).toBe("5");
});

test("the preview lists up to three current lanes from the merge queue", async () => {
  const root = await mount();
  expect(field<HTMLElement>(root, "#merge-lanes-preview").textContent).toBe(
    "Lanes now: Billing, Search, PAS-4 and 1 more",
  );
  const person = field(root, '[name="lane-person"]');
  person.checked = true;
  change(person);
  expect(field<HTMLElement>(root, "#merge-lanes-preview").textContent).toBe(
    "Lanes now: Billing · Ada, Billing · Ben, Search · Ada and 2 more",
  );
});

test("the preview names multiple repositories and a shared no-project lane", () => {
  const items = [
    { id: "PAS-1", repository: "acme/paws", project: null, owner: "Ada" },
    { id: "PAS-2", repository: "acme/api", project: null, owner: "Ben" },
  ];
  expect(laneNames(items, ["project"], "lane")).toEqual(["paws · No project", "api · No project"]);
  expect(laneNames(items, [], "own")).toEqual(["paws · PAS-1", "api · PAS-2"]);
  expect(laneNames([{ ...items[0]!, project: "Billing" }], [], "own")).toEqual(["acme/paws"]);
});

test("the preview arrives without discarding unsaved edits", async () => {
  let release!: (value: unknown) => void;
  queueReady = new Promise((resolve) => (release = resolve));
  const root = await mount();
  expect(field(root, "#merge-lanes-preview").textContent).toBe("");
  field(root, '[name="merge-ci-fix-attempts"]').value = "7";
  release(null);
  await settle();
  await settle();
  expect(field(root, "#merge-lanes-preview").textContent).toStartWith("Lanes now: Billing");
  expect(field(root, '[name="merge-ci-fix-attempts"]').value).toBe("7");
});

test("members see no enabled controls", async () => {
  status = 403;
  const root = await mount();
  expect(root.textContent).toContain("Only workspace admins can change merging settings.");
  const enabled = [...root.querySelectorAll("input, select, textarea, button")].filter(
    (control) => !(control as HTMLInputElement).disabled,
  );
  expect(enabled).toEqual([]);
});

test("at 375 px every lane label wraps inside the section instead of scrolling sideways", async () => {
  const root = await mount();
  expect(window.innerWidth).toBe(375);
  const section = field<HTMLElement>(root, "#merge-lanes");
  expect(section.innerHTML).not.toMatch(/nowrap|w-\[|min-w-\[|overflow-x/);
  expect(section.querySelector(".col")!.classList.contains("min-w-0")).toBe(true);
  for (const fieldset of section.querySelectorAll("fieldset"))
    expect(fieldset.classList.contains("min-w-0")).toBe(true);
  for (const label of section.querySelectorAll("label:has(input) > span"))
    expect([...label.classList]).toEqual(["min-w-0", "break-words"]);
  expect(field(root, "#merge-lanes-preview").classList.contains("break-words")).toBe(true);
});
