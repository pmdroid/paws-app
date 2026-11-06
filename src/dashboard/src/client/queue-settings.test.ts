import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSettings } from "../agent-settings";
import { SETTINGS_PAGES, renderSettingsPage } from "./settings-pages";
import { createQueueSettings, queueProblems, renderQueueSettings } from "./queue-settings";
import { themedMarkup } from "./theme";

const STORED: AgentSettings = {
  defaults: {
    implementer: { agent: "claude", model: null },
    reviewer: { agent: "codex", model: "gpt-5.4" },
  },
  projects: [{ repo: "pmdroid/barkvisor" }],
  merge: { ciFixAttempts: 3 },
  queue: { startTimeoutHours: 24, maxRunningPerOwner: null },
  revision: "r1",
};
const view = (queue: AgentSettings["queue"]) => ({
  queue: queue!,
  busy: null,
  error: null,
  saved: false,
});

test("Queue and limits follows Merging and holds the Queue and Time limits sections", () => {
  const ids = SETTINGS_PAGES.map((page) => page.id);
  expect(ids.indexOf("limits")).toBe(ids.indexOf("merging") + 1);
  expect(SETTINGS_PAGES.find((page) => page.id === "limits")).toMatchObject({
    name: "Queue and limits",
    description: "How long work may wait and run, and how much runs at once.",
  });
  const html = renderSettingsPage("limits");
  expect(html).toContain('id="queue-settings"');
  expect(html).toContain('id="time-limit-settings"');
});

test("the Queue section shows the start timeout in hours", () => {
  const html = renderQueueSettings(view({ startTimeoutHours: 24, maxRunningPerOwner: null }));
  expect(html).toContain("<h2>Queue</h2>");
  expect(html).toContain(
    '<label for="queue-start-timeout">Fail an item that has not started after, in hours</label>',
  );
  expect(html).toMatch(
    /name="queue-start-timeout" type="number"[^>]*min="1" max="720"[^>]*value="24"/,
  );
  expect(renderQueueSettings(view({ startTimeoutHours: 6 }))).toMatch(
    /name="queue-start-timeout"[^>]*value="6"/,
  );
  expect(queueProblems({ startTimeoutHours: 6 })).toEqual([]);
  for (const startTimeoutHours of [0, 721, 1.5, NaN])
    expect(queueProblems({ startTimeoutHours })).toEqual([
      "Queue start timeout: enter a whole number of hours from 1 to 720.",
    ]);
});

test("desktop: the Queue section offers an optional cap on running items per owner, empty by default", () => {
  const html = renderQueueSettings(view({ startTimeoutHours: 24, maxRunningPerOwner: null }));
  expect(html).toContain(
    '<label for="queue-owner-cap">Most items one person or project runs at once</label>',
  );
  expect(html).toMatch(/name="queue-owner-cap" type="number"[^>]*min="1"[^>]*value=""/);
  expect(html).not.toMatch(/name="queue-owner-cap"[^>]*required/);
  expect(renderQueueSettings(view({ startTimeoutHours: 24, maxRunningPerOwner: 3 }))).toMatch(
    /name="queue-owner-cap"[^>]*value="3"/,
  );
  for (const maxRunningPerOwner of [0, 2.5, NaN])
    expect(queueProblems({ startTimeoutHours: 24, maxRunningPerOwner })).toEqual([
      "Running items per owner: leave empty for no cap, or enter a whole number from 1 to 1000.",
    ]);
});

test("390 px: the owner cap field stacks in the Queue section without a fixed width", () => {
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      themedMarkup(renderQueueSettings(view({ startTimeoutHours: 24 }))),
    ),
  );
  expect(html).toContain('id="queue-owner-cap"');
  expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
});

let window: Window;
const realFetch = globalThis.fetch;
const saved = new Map<string, unknown>();
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
let requests: { url: string; init: RequestInit }[];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/settings/limits" });
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
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

function setValue(root: HTMLElement, name: string, value: string) {
  const field = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
}

function submit(root: HTMLElement) {
  root
    .querySelector("#queue-settings-form")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
}

test("saving puts the queue next to freshly read agent profiles and their revision, and reports the save", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  let savedCount = 0;
  createQueueSettings(() => savedCount++).mount(root, "http://127.0.0.1:8787");
  await settle();
  setValue(root, "queue-start-timeout", "6");
  setValue(root, "queue-owner-cap", "2");
  submit(root);
  await settle();
  await settle();
  expect(requests.map((request) => [request.init.method, request.url])).toEqual([
    ["GET", "http://127.0.0.1:8787/api/settings/agents"],
    ["GET", "http://127.0.0.1:8787/api/settings/agents"],
    ["PUT", "http://127.0.0.1:8787/api/settings/agents"],
  ]);
  const put = requests.at(-1)!;
  expect((put.init.headers as Record<string, string>)["x-paws-csrf"]).toBe("token-1");
  const { merge: _merge, ...agents } = STORED;
  expect(JSON.parse(String(put.init.body))).toEqual({
    ...agents,
    queue: { startTimeoutHours: 6, maxRunningPerOwner: 2 },
  });
  expect(savedCount).toBe(1);
  expect(root.innerHTML).toContain("Saved");
  expect(root.querySelector<HTMLInputElement>("#queue-start-timeout")!.value).toBe("6");
});

test("an invalid start timeout shows the problem and saves nothing", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  createQueueSettings().mount(root, "http://127.0.0.1:8787");
  await settle();
  setValue(root, "queue-start-timeout", "0");
  expect(root.querySelector<HTMLElement>("#queue-problems")!.hidden).toBe(false);
  expect(root.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  submit(root);
  await settle();
  expect(requests.map((request) => request.init.method)).toEqual(["GET"]);
});
