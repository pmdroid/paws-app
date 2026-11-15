import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  createAgentAccountSettings,
  renderAgentAccountSettings,
  type CentralAccount,
} from "./agent-account-settings";
import { renderSettingsPage, setSettingsAdmin } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const ENGINE = "http://127.0.0.1:8787";
const account = (id: string, label: string): CentralAccount => ({
  ...{ id, label, agent: "claude", extraUsage: false, signingIn: false, lease: null },
  credential: { refreshedAt: 0, runner: "R1" },
  usage: { limits: [{ window: "5h", usedPercent: 40, resetsAt: null }], observedAt: 0 },
});
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;
let requests: { method: string; path: string; body: unknown }[];
let canManage: boolean;
let failure: string | null;
let agent: CentralAccount["agent"];
let deviceState: string;
let polls: number;

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
  agent = "claude";
  deviceState = "pending";
  polls = 0;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
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
    if (pathname.endsWith("/device")) {
      if (agent !== "codex")
        return Response.json({ error: "Codex account is unavailable" }, { status: 404 });
      if (method === "GET") {
        polls++;
        return Response.json({ state: deviceState });
      }
      return Response.json({
        userCode: "ABCD-1234",
        verificationUri: "https://auth.openai.com/codex/device",
        interval: 0.03,
        expiresAt: Date.now() + 300000,
      });
    }
    if (pathname.endsWith("/sign-in"))
      return Response.json({
        runnerId: "R1",
        bindingId: "B1",
        agent: pathname.includes("/A1/") ? agent : "claude",
      });
    if (method !== "GET") return Response.json({ ok: true });
    return Response.json({
      canManage,
      accounts: [{ ...account("A1", "Work"), agent }, account("A2", "Home")],
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
    "by agentbox · Extra usage off",
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

test("a Claude account takes a pasted setup token and clears the field", async () => {
  setSettingsAdmin(true);
  const root = await mount();
  const card = root.querySelector('[data-account-id="A1"]')!;
  const form = card.querySelector("[data-account-token]")!;
  const input = form.querySelector("input") as unknown as HTMLInputElement;
  expect(input.type).toBe("password");
  input.value = " sk-ant-oat01-abc ";
  (form.querySelector("button") as unknown as HTMLButtonElement).click();
  await settle();
  expect(requests).toEqual([
    {
      method: "PUT",
      path: "/api/runners/agent-accounts/A1/token",
      body: { token: "sk-ant-oat01-abc" },
    },
  ]);
  expect(
    (
      root.querySelector(
        '[data-account-id="A1"] [data-account-token] input',
      ) as unknown as HTMLInputElement
    ).value,
  ).toBe("");
});

test("only Claude accounts render a setup token field", () => {
  const html = renderAgentAccountSettings({
    canManage: true,
    accounts: [account("A1", "Work"), { ...account("A2", "Codex"), agent: "codex" }],
    runners: {},
    busy: null,
    error: null,
    confirm: null,
  });
  expect(html.match(/data-account-token/g)).toHaveLength(1);
  expect(html.match(/data-account-action="sign-in"/g)).toHaveLength(1);
  expect(html).toMatch(/data-account-id="A2"[^]*data-account-action="sign-in"/);
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

test("Codex sign-in shows a device code, polls and closes after approval", async () => {
  agent = "codex";
  const root = await mount();
  await click(root, "A1", "sign-in");
  const dialog = window.document.querySelector("dialog")!;
  expect(dialog.querySelector("h2")?.textContent).toBe("Sign in to Codex for Work");
  expect(dialog.querySelector("[data-device-code]")?.textContent).toBe("ABCD-1234");
  expect(dialog.querySelector("a")?.href).toBe("https://auth.openai.com/codex/device");
  expect(dialog.textContent).toContain("Waiting for you to approve… expires in 5 min");
  expect(dialog.textContent).not.toContain("agentbox");
  expect(dialog.querySelector("pre")).toBeNull();
  expect(opened).toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 45));
  expect(polls).toBeGreaterThan(0);
  deviceState = "signed-in";
  await new Promise((resolve) => setTimeout(resolve, 45));
  expect(dialog.textContent).toContain("Signed in");
  await new Promise((resolve) => setTimeout(resolve, 1050));
  expect(window.document.querySelector("dialog")).toBeNull();
  expect(requests.some((entry) => entry.path.endsWith("/sign-in"))).toBe(false);
});
for (const state of ["expired", "denied"]) {
  test(`device sign-in ${state} offers Retry`, async () => {
    agent = "codex";
    deviceState = state;
    const root = await mount();
    await click(root, "A1", "sign-in");
    await new Promise((resolve) => setTimeout(resolve, 45));
    const dialog = window.document.querySelector("dialog")!;
    expect(dialog.textContent).toContain(`Sign-in ${state}`);
    const retry = dialog.querySelector("[data-device-retry]") as unknown as HTMLButtonElement;
    expect(retry.hidden).toBe(false);
    deviceState = "pending";
    retry.click();
    await settle();
    expect((dialog.querySelector("[data-device-challenge]") as unknown as HTMLElement).hidden).toBe(
      false,
    );
    expect(requests.filter((entry) => entry.path.endsWith("/device"))).toHaveLength(2);
    (dialog.querySelector("[data-device-close]") as unknown as HTMLButtonElement).click();
  });
}

for (const provider of ["claude", "grok", "opencode"] as const) {
  test(`${provider} keeps the supported runner sign-in flow`, async () => {
    agent = provider;
    const root = await mount();
    await click(root, "A1", "sign-in");
    expect(requests).toEqual([
      { method: "POST", path: "/api/runners/agent-accounts/A1/sign-in", body: undefined },
    ]);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.slice(0, 2)).toEqual([{ id: "R1", name: "agentbox" }, provider]);
    expect(opened[0]?.slice(3)).toEqual(["B1", "Work"]);
    expect(window.document.querySelector("[data-device-code]")).toBeNull();
  });
}

for (const manage of [true, false]) {
  test(`usage windows and account states render with management ${manage}`, () => {
    const reset = Date.now() + 3600000;
    const row = account("A1", "Work");
    row.usage = {
      observedAt: Date.now() - 180000,
      limits: [
        { window: "5-hour", usedPercent: 62, resetsAt: reset },
        { window: "Weekly", usedPercent: 30, resetsAt: reset + 86400000 },
      ],
    };
    const render = () => {
      window.document.body.innerHTML = renderAgentAccountSettings({
        canManage: manage,
        accounts: [row],
        runners: {},
        busy: null,
        error: null,
        confirm: null,
      });
      return window.document.body.textContent;
    };
    expect(render()).toContain("5-hour 62% · resets");
    expect(render()).toContain("Weekly 30% · resets");
    expect(render()).toContain(
      new Date(reset).toLocaleString([], {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    expect(render()).toContain("updated 3 min ago");
    expect(window.document.querySelectorAll("progress")).toHaveLength(2);
    expect(window.document.querySelector("progress")?.value).toBe(62);
    row.usage.stale = true;
    row.usage.limits[0]!.usedPercent = 100;
    expect(render()).toContain("stale");
    expect(render()).toContain("Limit reached until");
    row.extraUsage = true;
    expect(render()).toContain("Using extra usage");
    row.usage = null;
    render();
    expect(window.document.querySelector("[data-account-usage]")).toBeNull();
  });
}
