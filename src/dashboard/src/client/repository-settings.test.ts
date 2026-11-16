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
let legacy: string[] = [];
let confirmed = false;
let confirmations: string[] = [];
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
  legacy = [];
  confirmed = false;
  confirmations = [];
  Object.defineProperty(window, "confirm", {
    value: (message?: string) => {
      confirmations.push(message ?? "");
      return confirmed;
    },
  });
  globalThis.fetch = (async (url: URL, init: RequestInit) => {
    const path = url.pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      method: init.method!,
      body,
      csrf: (init.headers as Record<string, string>)["x-paws-csrf"],
    });
    if (init.method === "PUT")
      return invalid
        ? Response.json({ error: "Server says this value is invalid" }, { status: 400 })
        : Response.json({ ...body, restartRequired: true });
    return Response.json(
      path.endsWith("github-access")
        ? { agentRead: legacy.length > 0, mirrors: true, agentReadOff: legacy }
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
async function mount(page: "repositories" | "linear") {
  setSettingsAdmin(true);
  window.document.body.innerHTML = renderSettingsPage(page);
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

for (const agentRead of [true, false]) {
  test(`legacy exclusions require confirmation before saving agentRead=${agentRead}`, async () => {
    legacy = ["private/one", "private/two"];
    await mount("repositories");
    window.document.querySelector<HTMLInputElement>('[name="agentRead"]')!.checked = agentRead;
    window.document.querySelector<HTMLInputElement>('[name="mirrors"]')!.checked = false;
    submit("access");
    await settleReactWork();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    expect(confirmations[0]).toContain("private/one, private/two");
    expect(confirmations[0]).toContain(
      agentRead ? "allowed to read every repository" : "denied read access to every repository",
    );
    expect(window.document.querySelector<HTMLInputElement>('[name="mirrors"]')!.checked).toBe(
      false,
    );
    confirmed = true;
    submit("access");
    await settleReactWork();
    expect(calls.at(-1)?.body).toEqual({ agentRead, mirrors: false });
    submit("access");
    await settleReactWork();
    expect(confirmations).toHaveLength(2);
  });
}
test("policy-only saves leave legacy access exclusions alone", async () => {
  legacy = ["private/one"];
  await mount("repositories");
  submit("policies");
  await settleReactWork();
  expect(confirmations).toHaveLength(0);
  expect(calls.filter((call) => call.method === "PUT").map((call) => call.path)).toEqual([
    "/api/settings/closeout",
  ]);
});
test("a failed migration save still requires confirmation on retry", async () => {
  legacy = ["private/one"];
  await mount("repositories");
  confirmed = true;
  invalid = true;
  submit("access");
  await settleReactWork();
  confirmed = false;
  submit("access");
  await settleReactWork();
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(confirmations).toHaveLength(2);
});
