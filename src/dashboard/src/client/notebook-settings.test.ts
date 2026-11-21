import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { WORKSPACE_PAGES, renderSettingsPage, setSettingsAdmin } from "./settings-pages";
import { NOTEBOOK_EMPTY, NOTEBOOK_FULL, createNotebookSettings } from "./notebook-settings";
import { settleReactWork } from "./settle-react";

const ENGINE = "http://127.0.0.1:8787";
const LIST = [
  { kind: "project", id: "p1", name: "Launch", size: 40, limit: 4000 },
  { kind: "repository", id: "acme/app", name: "acme/app", size: 812, limit: 12000 },
];
const change = (id: string, action: string, extra: Record<string, unknown>) => ({
  ...{ id, entryId: "e1", action, before: null, after: null, item: null, actor: null },
  ...{ at: Date.UTC(2026, 10, 20, 12), undoable: false },
  ...extra,
});
const NOTEBOOK = {
  kind: "repository",
  id: "acme/app",
  revision: 3,
  size: 812,
  limit: 12000,
  entries: [
    { id: "e1", body: "Run bun run check before pushing.", updatedAt: 1 },
    { id: "e2", body: "The dashboard is static files.", updatedAt: 2 },
  ],
  changes: [
    change("c1", "add", { after: "Run bun run check.", item: "PAS-12" }),
    change("c2", "patch", {
      ...{ before: "Run bun run check.", after: "Run bun run check before pushing." },
      ...{ actor: "Ann", at: Date.UTC(2026, 10, 20, 13), undoable: true },
    }),
  ],
};

let window: Window;
const realFetch = globalThis.fetch;
const saved = new Map<string, unknown>();
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
let requests: { url: string; method: string; body: unknown }[];
let reply: (url: string, body: unknown) => Response;
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  setSettingsAdmin(true);
  window = new Window({ url: `${ENGINE}/workspace/notebook` });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  reply = (url) =>
    Response.json(new URL(url).pathname === "/api/notebooks" ? { notebooks: LIST } : NOTEBOOK);
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), method: init.method ?? "GET", body });
    expect(init.body ? (init.headers as Record<string, string>)["x-paws-csrf"] : "token-1").toBe(
      "token-1",
    );
    return reply(String(url), body);
  }) as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

const button = (root: HTMLElement, name: string, within: Element = root) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  )!;
const click = async (target: HTMLElement) => {
  target.click();
  await settle();
};
const submit = async (root: HTMLElement, form: string, value: string) => {
  const element = root.querySelector<HTMLFormElement>(`[data-notebook-form="${form}"]`)!;
  element.querySelector("textarea")!.value = value;
  element.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
  await settle();
};
const entryItem = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('[aria-label="Entries"] > li')].find((item) =>
    item.textContent?.includes(text),
  )!;

async function opened() {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  createNotebookSettings().mount(root, ENGINE);
  await settle();
  await click(button(root, "acme/app"));
  return root;
}

test("Notebook is a Workspace page", () => {
  expect(WORKSPACE_PAGES.find((page) => page.id === "notebook")?.name).toBe("Notebook");
  expect(renderSettingsPage("notebook")).toContain('id="notebook-settings"');
});

test("the list shows repositories first, then projects, with their size", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  createNotebookSettings().mount(root, ENGINE);
  await settle();
  const headings = [...root.querySelectorAll("h2")].map((heading) => heading.textContent);
  expect(headings).toEqual(["Repositories", "Projects"]);
  expect(root.textContent).toContain("acme/app812 of 12,000 characters");
  expect(root.textContent).toContain("Launch40 of 4,000 characters");
});

test("opening a notebook shows its size, entries and history newest first", async () => {
  const root = await opened();
  expect(requests.at(-1)!.url).toBe(`${ENGINE}/api/notebooks/repository/acme%2Fapp`);
  expect(root.querySelector("progress")!.getAttribute("value")).toBe("812");
  expect(root.textContent).toContain("812 of 12,000 characters");
  expect(entryItem(root, "Run bun run check before pushing.").textContent).toContain("EditRemove");
  const history = [...root.querySelectorAll('[aria-label="History"] > li')].map(
    (item) => item.textContent,
  );
  expect(history[0]).toStartWith("Ann changed, on the dashboard, ");
  expect(history[0]).toContain(
    "Before: Run bun run check.After: Run bun run check before pushing.",
  );
  expect(history[0]).toContain("Undo");
  expect(history[1]).toStartWith("An agent added, PAS-12, ");
  expect(history[1]).not.toContain("Undo");
});

test("an empty notebook says so", async () => {
  reply = (url) =>
    Response.json(
      new URL(url).pathname === "/api/notebooks"
        ? { notebooks: LIST }
        : { ...NOTEBOOK, size: 0, entries: [], changes: [] },
    );
  const root = await opened();
  expect(root.textContent).toContain(NOTEBOOK_EMPTY);
});

test("Add sends an add operation", async () => {
  const root = await opened();
  await submit(root, "add", "Migrations are append-only.");
  expect(requests.at(-1)).toMatchObject({
    method: "POST",
    url: `${ENGINE}/api/notebooks/repository/acme%2Fapp/edits`,
    body: { operations: [{ action: "add", content: "Migrations are append-only." }] },
  });
});

test("Edit turns the entry into a text area and Save sends a patch", async () => {
  const root = await opened();
  await click(button(root, "Edit", entryItem(root, "static files")));
  expect(
    root.querySelector<HTMLTextAreaElement>('[data-notebook-form="edit:e2"] textarea')!.value,
  ).toBe("The dashboard is static files.");
  expect(button(root, "Cancel")).toBeDefined();
  await submit(root, "edit:e2", "The dashboard ships as static files.");
  expect(requests.at(-1)!.body).toEqual({
    operations: [
      {
        action: "patch",
        old_text: "The dashboard is static files.",
        content: "The dashboard ships as static files.",
      },
    ],
  });
  expect(root.querySelector('[data-notebook-form="edit:e2"]')).toBeNull();
});

test("Remove asks once in place and then sends a remove", async () => {
  const root = await opened();
  await click(button(root, "Remove", entryItem(root, "static files")));
  const item = entryItem(root, "static files");
  expect(item.textContent).toContain("Remove this entry?");
  expect(requests.at(-1)!.method).toBe("GET");
  await click(button(root, "Remove", item));
  expect(requests.at(-1)!.body).toEqual({
    operations: [{ action: "remove", old_text: "The dashboard is static files." }],
  });
});

test("Undo sends the change id", async () => {
  const root = await opened();
  await click(button(root, "Undo"));
  expect(requests.at(-1)).toMatchObject({
    method: "POST",
    url: `${ENGINE}/api/notebooks/repository/acme%2Fapp/undo`,
    body: { changeId: "c2" },
  });
});

test("a full notebook shows the refusal next to Add and keeps the draft", async () => {
  const root = await opened();
  reply = () =>
    Response.json(
      {
        error:
          "the notebook would hold 12040 characters, over its 12000 limit; remove or shorten entries in the same call",
        operation: null,
        notebook: NOTEBOOK,
      },
      { status: 409 },
    );
  await submit(root, "add", "One more thing.");
  const form = root.querySelector('[data-notebook-form="add"]')!;
  expect(form.querySelector('[role="alert"]')!.textContent).toBe(NOTEBOOK_FULL);
  expect(form.querySelector("textarea")!.value).toBe("One more thing.");
  expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);
});
