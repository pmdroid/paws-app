import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createAgentAccountSettings, type CentralAccount } from "./agent-account-settings";
import { renderSettingsPage, setSettingsAdmin } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const ENGINE = "http://127.0.0.1:8787";
const account = (id: string, label: string): CentralAccount => ({
  ...{ id, label, agent: "claude", extraUsage: false, signingIn: false, lease: null },
  credential: { refreshedAt: 0, runner: "R1" },
  usage: { limits: [{ window: "5h", usedPercent: 40 }] },
});
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;
let requests: { method: string; path: string; body: unknown }[];
let canManage: boolean;
let failure: string | null;

beforeEach(() => {
  window = new Window({ url: `${ENGINE}/settings/agent-accounts` });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  canManage = true;
  failure = null;
  opened.length = 0;
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    const { pathname, search } = new URL(String(url));
    const method = init.method ?? "GET";
    if (method !== "GET") {
      requests.push({
        method,
        path: pathname + search,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      expect(new Headers(init.headers).get("x-paws-csrf")).toBe("token-1");
    }
    if (failure && method !== "GET") return Response.json({ error: failure }, { status: 409 });
    if (pathname === "/api/runners")
      return Response.json({ runners: [{ id: "R1", name: "agentbox" }] });
    if (pathname.endsWith("/sign-in"))
      return Response.json({ runnerId: "R1", bindingId: "B1", agent: "claude" });
    if (method !== "GET") return Response.json({ ok: true });
    return Response.json({
      canManage,
      accounts: [account("A1", "Work"), account("A2", "Home")],
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

const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  await settleReactWork();
};
const opened: unknown[][] = [];
async function mount() {
  window.document.body.innerHTML = renderSettingsPage("agent-accounts");
  const root = window.document.querySelector("#agent-account-settings") as unknown as HTMLElement;
  createAgentAccountSettings((...args) => void opened.push(args)).mount(root, ENGINE);
  await settle();
  return root;
}
const click = async (root: HTMLElement, id: string, action: string) => {
  root
    .querySelector<HTMLElement>(`[data-account-id="${id}"] [data-account-action="${action}"]`)!
    .click();
  await settle();
};

test("an admin adds, reorders, toggles extra usage, signs out and signs in", async () => {
  setSettingsAdmin(true);
  const root = await mount();
  expect(root.querySelector("h2")?.textContent).toBe("Claude");
  expect([...root.querySelectorAll("li strong")].map((node) => node.textContent)).toEqual([
    "Work",
    "Home",
  ]);
  expect(root.querySelector("[data-account-status]")?.textContent).toContain(
    "by agentbox · 5h: 40% used · Extra usage off",
  );
  const form = root.querySelector("[data-account-add]")!;
  (form.querySelector("select") as unknown as HTMLSelectElement).value = "codex";
  (form.querySelector("input") as unknown as HTMLInputElement).value = " Team ";
  (form.querySelector("button") as unknown as HTMLButtonElement).click();
  await settle();
  await click(root, "A2", "up");
  await click(root, "A1", "extra-usage");
  await click(root, "A1", "sign-out");
  expect(root.querySelector('[role="alert"]')?.textContent).toContain(
    "Sign Work out on every runner?",
  );
  await click(root, "A1", "sign-out-confirm");
  await click(root, "A2", "sign-in");
  expect(requests).toEqual([
    {
      method: "POST",
      path: "/api/runners/agent-accounts",
      body: { agent: "codex", label: "Team" },
    },
    {
      method: "PUT",
      path: "/api/runners/agent-accounts/order",
      body: { agent: "claude", ids: ["A2", "A1"] },
    },
    {
      method: "PUT",
      path: "/api/runners/agent-accounts/A1/extra-usage",
      body: { extraUsage: true },
    },
    { method: "DELETE", path: "/api/runners/agent-accounts/A1/credential", body: undefined },
    { method: "POST", path: "/api/runners/agent-accounts/A2/sign-in", body: undefined },
  ]);
  expect(opened.at(-1)?.slice(0, 2)).toEqual([{ id: "R1", name: "agentbox" }, "claude"]);
  expect(opened.at(-1)?.[3]).toBe("B1");
});

test("an admin sees the API's error message", async () => {
  setSettingsAdmin(true);
  const root = await mount();
  failure = "None of your runners is online with central sign-ins.";
  await click(root, "A1", "sign-in");
  expect(root.querySelector('[role="alert"]')?.textContent).toBe(failure);
  expect(opened).toHaveLength(0);
});

test("a member sees the accounts read-only, with no controls", async () => {
  setSettingsAdmin(false);
  canManage = false;
  const root = await mount();
  expect([...root.querySelectorAll("li strong")].map((node) => node.textContent)).toEqual([
    "Work",
    "Home",
  ]);
  expect(root.querySelectorAll("button, input, select, form, [draggable]")).toHaveLength(0);
  expect(requests).toEqual([]);
});
