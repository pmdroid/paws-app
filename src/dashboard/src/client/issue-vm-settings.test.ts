import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createIssueVmSettings } from "./issue-vm-settings";
import { renderSettingsPage, setSettingsAdmin } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const ENGINE = "http://127.0.0.1:8787";
const RUNNER = "01JRRNNER0000000000000000A";
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;
let calls: { method: string; path: string; body: unknown }[];
let limits: Record<string, number>;
let grant: Record<string, unknown> | null;
let host: Record<string, unknown>;
let failing: Set<string>;

const member = () => ({
  userId: "user-2",
  name: "Robin",
  role: "member",
  inUse: { creating: 0, awake: 1, asleep: 0, total: 1 },
  limit: grant ? (grant.limit as number) : limits.perMember!,
  grant,
});

beforeEach(() => {
  window = new Window({ url: `${ENGINE}/workspace/issue-vms` });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  calls = [];
  limits = { perMember: 2, workspaceMax: 10, deleteAfterDays: 7 };
  grant = null;
  failing = new Set();
  host = {
    runnerId: RUNNER,
    vmHost: true,
    settings: {
      vmVcpus: 2,
      vmMemoryGb: 4,
      vmDiskGb: 30,
      reserveVcpus: 4,
      reserveMemoryGb: 8,
      slotCap: null,
    },
    slots: { slots: 6, reason: "cpu" },
  };
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (failing.has(`${method} ${path}`))
      return Response.json({ error: "Paws is restarting." }, { status: 503 });
    if (path === "/api/auth/session") return Response.json({ userId: "user-2" });
    if (path === "/api/settings/issue-vm") {
      if (method === "PUT") {
        if (body.workspaceMax > 500)
          return Response.json(
            { error: "issue_vm.workspace_max must be a whole number from 1 to 500" },
            { status: 400 },
          );
        limits = body;
      }
      return Response.json(limits);
    }
    if (path === "/api/settings/issue-vm/members")
      return Response.json({ defaultLimit: limits.perMember, members: [member()] });
    if (path === "/api/settings/issue-vm/grants") {
      grant = { id: "grant1", ...body, endsAt: Date.parse(body.endsAt) };
      return Response.json({ grant }, { status: 201 });
    }
    if (path === "/api/settings/issue-vm/grants/grant1") {
      grant = null;
      return Response.json({});
    }
    if (path === "/api/runners")
      return Response.json({ runners: [{ id: RUNNER, name: "goldbox" }] });
    if (path === `/api/runners/${RUNNER}/vm-host` && method === "PUT")
      host = {
        ...host,
        settings: body,
        slots: { slots: Math.floor(12 / body.vmVcpus), reason: "cpu" },
      };
    return Response.json(host);
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
  for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  await settleReactWork();
};

async function mount(admin = true) {
  setSettingsAdmin(admin);
  window.document.body.innerHTML = admin
    ? renderSettingsPage("issue-vms")
    : '<div id="issue-vm-settings"></div>';
  const root = window.document.querySelector("#issue-vm-settings") as unknown as HTMLElement;
  createIssueVmSettings().mount(root, ENGINE);
  await settle();
  return root;
}

function type(root: HTMLElement, selector: string, value: string) {
  root.querySelector<HTMLInputElement>(selector)!.value = value;
}

async function submit(root: HTMLElement, selector: string) {
  root
    .querySelector(selector)!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
  await settle();
}

test("an admin saves each limit and sees an out-of-range value refused", async () => {
  const root = await mount();
  expect(root.querySelector<HTMLInputElement>("#issue-vm-perMember")!.value).toBe("2");
  expect(root.textContent).toContain("1 to 500");
  type(root, "#issue-vm-perMember", "3");
  type(root, "#issue-vm-workspaceMax", "20");
  type(root, "#issue-vm-deleteAfterDays", "14");
  await submit(root, "[data-limits]");
  expect(limits).toEqual({ perMember: 3, workspaceMax: 20, deleteAfterDays: 14 });
  expect(root.textContent).toContain("Limits saved.");
  type(root, "#issue-vm-workspaceMax", "900");
  await submit(root, "[data-limits]");
  expect(root.querySelector('[role="alert"]')?.textContent).toContain("from 1 to 500");
});

test("an admin adds and revokes a grant", async () => {
  const root = await mount();
  type(root, "#issue-vm-grant-limit", "5");
  type(root, "#issue-vm-grant-ends", "2099-01-31");
  await submit(root, "[data-grant]");
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({
    memberUserId: "user-2",
    limit: 5,
    endsAt: "2099-01-31T23:59:59Z",
  });
  expect(root.textContent).toContain("5 until 2099-01-31");
  root
    .querySelector("[data-revoke]")!
    .dispatchEvent(new window.Event("click", { bubbles: true }) as never);
  await settle();
  expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  expect(root.textContent).toContain("Grant revoked.");
  expect(root.querySelector("[data-revoke]")).toBeNull();
});

test("an admin changes a host's VM size and sees the new slots", async () => {
  const root = await mount();
  expect(root.querySelector(`[data-slots="${RUNNER}"]`)?.textContent).toBe(
    "6 slots, limited by vCPUs",
  );
  type(root, `#vm-host-${RUNNER}-vmVcpus`, "4");
  await submit(root, `[data-host="${RUNNER}"]`);
  expect(
    calls.find((call) => call.method === "PUT" && call.path.endsWith("vm-host"))?.body,
  ).toEqual({ vmVcpus: 4, vmMemoryGb: 4, vmDiskGb: 30, reserveVcpus: 4, reserveMemoryGb: 8 });
  expect(root.querySelector(`[data-slots="${RUNNER}"]`)?.textContent).toBe(
    "3 slots, limited by vCPUs",
  );
});

test("a member sees only their own limit and grant, read-only", async () => {
  grant = { id: "grant1", memberUserId: "user-2", limit: 4, endsAt: Date.parse("2099-02-01") };
  const root = await mount(false);
  expect(root.textContent).toContain("Robin");
  expect(root.textContent).toContain("4 until 2099-02-01");
  expect(root.querySelectorAll("input, select, button").length).toBe(0);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("saving the default limit refreshes an ungranted member's limit", async () => {
  const root = await mount();
  type(root, "#issue-vm-perMember", "4");
  await submit(root, "[data-limits]");
  expect(root.querySelector("tbody td:nth-child(3)")?.textContent).toBe("4");
});

test("a failed member reload after a grant shows an error, not success", async () => {
  const root = await mount();
  failing.add("GET /api/settings/issue-vm/members");
  type(root, "#issue-vm-grant-limit", "5");
  type(root, "#issue-vm-grant-ends", "2099-01-31");
  await submit(root, "[data-grant]");
  expect(root.querySelector('[role="alert"]')?.textContent).toBe(
    "Grant added. The member list could not be reloaded: Paws is restarting.",
  );
});

test("a runner whose VM host lookup failed is not offered as a new host", async () => {
  failing.add(`GET /api/runners/${RUNNER}/vm-host`);
  const root = await mount();
  expect(root.querySelector("[data-add-host]")).toBeNull();
  expect(root.querySelector('[role="alert"]')?.textContent).toContain("Paws is restarting.");
});
