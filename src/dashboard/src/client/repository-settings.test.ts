import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window, type HTMLInputElement, type HTMLButtonElement } from "happy-dom";
import { mountRepositorySettings } from "./repository-settings";
import { renderSettingsPage, setSettingsAdmin } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const globals = [
  "window",
  "document",
  "Element",
  "HTMLElement",
  "Event",
  "FormData",
  "SubmitEvent",
] as const;
const saved = new Map<string, unknown>();
const originalFetch = globalThis.fetch;
let window: Window;
let calls: { path: string; method: string; body: unknown; csrf: unknown }[];
let invalid = false;
let descriptions: { repository: string; text: string | null; source: string | null }[];
beforeEach(() => {
  window = new Window({ url: "http://localhost/dashboard" });
  for (const key of globals) {
    saved.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = key === "window" ? window : window[key];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="test-token">';
  setSettingsAdmin(true);
  calls = [];
  invalid = false;
  descriptions = [
    { repository: "owner/repo", text: "Billing service", source: "paws" },
    { repository: "owner/docs", text: "Product docs", source: "github" },
    { repository: "owner/empty", text: null, source: null },
  ];
  globalThis.fetch = (async (url: URL, init: RequestInit) => {
    const path = url.pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      method: init.method!,
      body,
      csrf: (init.headers as Record<string, string>)["x-paws-csrf"],
    });
    if (path.endsWith("repository-descriptions")) {
      if (invalid) return Response.json({ error: "Descriptions are unavailable" }, { status: 503 });
      descriptions = descriptions.map((entry) =>
        entry.repository !== body?.repository
          ? entry
          : init.method === "PUT"
            ? { ...entry, text: body.text, source: "admin" }
            : { ...entry, text: null, source: null },
      );
      return Response.json({ repositories: descriptions });
    }
    if (init.method === "PUT")
      return invalid
        ? Response.json({ error: "Server says this value is invalid" }, { status: 400 })
        : Response.json({ ...body, restartRequired: true });
    return Response.json(
      path.endsWith("github-access")
        ? { agentRead: false, mirrors: true }
        : path.endsWith("closeout")
          ? { projects: { "owner/repo": { policyRoot: "/policy" } } }
          : { agents: ["app_1", "app_2"] },
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of globals) (globalThis as Record<string, unknown>)[key] = saved.get(key);
  void window.happyDOM.abort();
});
async function mount(page: "repositories" | "linear", admin = true) {
  setSettingsAdmin(true);
  window.document.body.innerHTML = renderSettingsPage(page);
  setSettingsAdmin(admin);
  mountRepositorySettings("http://localhost");
  await settleReactWork();
}
function submit(value?: string) {
  const button = value
    ? window.document.querySelector<HTMLButtonElement>(`button[value="${value}"]`)
    : window.document.querySelector<HTMLButtonElement>('button[type="submit"]');
  window.document.querySelector("form")!.dispatchEvent(
    new window.SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter: button ?? undefined,
    }),
  );
}
test("repository settings load and save only editable fields, keeping the restart notice", async () => {
  await mount("repositories");
  expect(window.document.querySelector<HTMLInputElement>('[name="agentRead"]')!.checked).toBe(
    false,
  );
  expect(window.document.querySelector<HTMLInputElement>('[name="mirrors"]')!.checked).toBe(true);
  expect(window.document.querySelector<HTMLInputElement>('[name="root-0"]')!.value).toBe("/policy");
  window.document.querySelector<HTMLInputElement>('[name="agentRead"]')!.checked = true;
  submit("access");
  await settleReactWork();
  expect(calls.at(-1)).toEqual({
    path: "/api/settings/github-access",
    method: "PUT",
    body: { agentRead: true, mirrors: true },
    csrf: "test-token",
  });
  expect(window.document.body.textContent).toContain("Restart Paws");
  submit("policies");
  await settleReactWork();
  expect(calls.at(-1)?.body).toEqual({ projects: { "owner/repo": { policyRoot: "/policy" } } });
});
test("policy roots can be added, removed and cleared", async () => {
  await mount("repositories");
  window.document.querySelector<HTMLButtonElement>("[data-add]")!.click();
  await settleReactWork();
  window.document.querySelector<HTMLInputElement>('[name="repo-1"]')!.value = "new/repo";
  window.document.querySelector<HTMLInputElement>('[name="root-1"]')!.value = "/new-policy";
  window.document.querySelector<HTMLButtonElement>('[data-remove="0"]')!.click();
  await settleReactWork();
  submit("policies");
  await settleReactWork();
  expect(calls.at(-1)?.body).toEqual({ projects: { "new/repo": { policyRoot: "/new-policy" } } });
  window.document.querySelector<HTMLButtonElement>('[data-remove="0"]')!.click();
  await settleReactWork();
  submit("policies");
  await settleReactWork();
  expect(calls.at(-1)?.body).toEqual({ projects: {} });
});
for (const page of ["repositories", "linear"] as const) {
  test(`${page} shows server validation errors and preserves the draft`, async () => {
    await mount(page);
    invalid = true;
    submit(page === "repositories" ? "policies" : undefined);
    await settleReactWork();
    expect(window.document.querySelector('[role="alert"]')?.textContent).toBe(
      "Server says this value is invalid",
    );
    expect(window.document.querySelector("textarea, input")?.getAttribute("name")).toBeTruthy();
  });
}
test("Linear comment agents save and clear through their route", async () => {
  await mount("linear");
  const textarea = window.document.querySelector("textarea")!;
  expect(textarea.value).toBe("app_1\napp_2");
  textarea.value = "app_3\n\napp_4";
  submit();
  await settleReactWork();
  expect(calls.at(-1)?.body).toEqual({ agents: ["app_3", "app_4"] });
  window.document.querySelector("textarea")!.value = "";
  submit();
  await settleReactWork();
  expect(calls.at(-1)?.body).toEqual({ agents: [] });
});
function describe(index: number, text: string) {
  const input = window.document.querySelector<HTMLInputElement>(`#description-${index}`)!;
  input.value = text;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.form!.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
}
const project = (index: number) =>
  window.document.querySelectorAll(".settings-project")[1 + index]!.textContent;
test("repository descriptions show their text and who wrote it", async () => {
  await mount("repositories");
  const text = window.document.body.textContent;
  expect(text).toContain("Agents see this when they choose which repository to read.");
  expect(project(0)).toContain("Written by Paws");
  expect(project(1)).toContain("From GitHub");
  expect(project(2)).toContain("No description yet");
  expect(window.document.querySelector<HTMLInputElement>("#description-1")!.value).toBe(
    "Product docs",
  );
});
test("saving a description calls PUT and Let Paws write it calls DELETE", async () => {
  await mount("repositories");
  describe(0, "Handles invoices");
  await settleReactWork();
  expect(calls.at(-1)).toEqual({
    path: "/api/settings/repository-descriptions",
    method: "PUT",
    body: { repository: "owner/repo", text: "Handles invoices" },
    csrf: "test-token",
  });
  expect(project(0)).toContain("Written by an admin");
  window.document.querySelector<HTMLButtonElement>('[data-description-clear="0"]')!.click();
  await settleReactWork();
  expect(calls.at(-1)).toMatchObject({ method: "DELETE", body: { repository: "owner/repo" } });
  expect(project(0)).toContain("No description yet");
});
test("a description over 300 characters is not sent and the counter shows from 250", async () => {
  await mount("repositories");
  const before = calls.length;
  describe(2, "x".repeat(301));
  await settleReactWork();
  expect(calls.length).toBe(before);
  expect(window.document.querySelector("#description-2-error")?.textContent).toContain("300");
  expect(window.document.querySelector('[data-description-counter="2"]')?.textContent).toBe(
    "301/300",
  );
  const input = window.document.querySelector<HTMLInputElement>("#description-2")!;
  input.value = "x".repeat(249);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  expect(window.document.querySelector('[data-description-counter="2"]')?.textContent).toBe("");
});
test("a description error appears beside the field and keeps the typed text", async () => {
  await mount("repositories");
  invalid = true;
  describe(1, "Typed text");
  await settleReactWork();
  expect(window.document.querySelector("#description-1-error")?.textContent).toBe(
    "Descriptions are unavailable",
  );
  expect(window.document.querySelector<HTMLInputElement>("#description-1")!.value).toBe(
    "Typed text",
  );
});
test("members who are not admins see descriptions without editing controls", async () => {
  await mount("repositories", false);
  expect(window.document.body.textContent).toContain("Billing service");
  expect(window.document.querySelector("#description-0")).toBeNull();
  expect(window.document.querySelector("[data-description-clear]")).toBeNull();
});
