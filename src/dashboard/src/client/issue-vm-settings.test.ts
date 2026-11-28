import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createIssueVmSettings } from "./issue-vm-settings";
import {
  renderSettingsPage,
  setSettingsAdmin,
  settingsRedirect,
  shownSettingsPage,
} from "./settings-pages";
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
let spend: Record<string, unknown>;
let host: Record<string, unknown>;
let failing: Set<string>;
let others: Record<string, unknown>[];
let failingDeletes: Record<string, unknown>[];
let sizes: Record<string, Record<string, unknown>>;
let offProviders: string[];
let instaBoxKey: boolean;

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
  spend = {
    month: "2026-11",
    spentUsd: 40,
    monthlyLimitUsd: 50,
    prices: { boat: 0.12, instabox: null },
  };
  failing = new Set();
  others = [];
  failingDeletes = [];
  sizes = { "exe-dev": {}, boat: {}, instabox: {} };
  offProviders = [];
  instaBoxKey = true;
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
    if (path === "/api/settings/issue-vm/spend") {
      if (method === "PUT")
        spend = {
          ...spend,
          ...(body.monthlyLimitUsd === undefined ? {} : { monthlyLimitUsd: body.monthlyLimitUsd }),
          prices: { ...(spend.prices as object), ...body.prices },
          snapshots: { ...(spend.snapshots as object), ...body.snapshots },
        };
      return Response.json(spend);
    }
    if (path === "/api/settings/issue-vm/members")
      return Response.json({
        defaultLimit: limits.perMember,
        failingDeletes,
        members: [member(), ...others],
      });
    if (path === "/api/settings/issue-vm/grants") {
      if (body.limit > 50)
        return Response.json(
          { error: "limit must be a whole number from 1 to 50" },
          { status: 400 },
        );
      const created = { id: "grant1", ...body, endsAt: Date.parse(body.endsAt) };
      if (body.memberUserId === "user-2") grant = created;
      return Response.json({ grant: created }, { status: 201 });
    }
    if (path === "/api/settings/issue-vm/grants/grant1") {
      grant = null;
      return Response.json({});
    }
    if (path === "/api/settings/vm-sizes") {
      if (body?.sizes?.["exe-dev"]?.cpu < 1)
        return Response.json({ error: "cpu must be a positive integer" }, { status: 400 });
      if (body?.sizes) sizes = { ...sizes, ...body.sizes };
      if (body?.offProviders) offProviders = body.offProviders;
      const pairs = [
        [2, 4],
        [4, 8],
      ];
      const instabox = instaBoxKey
        ? {
            allowed: [
              [1, 2],
              [2, 4],
            ],
          }
        : { note: "Save an InstaBox key to list sizes" };
      return Response.json({
        offProviders,
        providers: {
          "exe-dev": { size: sizes["exe-dev"] },
          boat: { size: sizes.boat, allowed: pairs },
          instabox: { size: sizes.instabox, ...instabox },
        },
      });
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
  window.document.body.innerHTML = renderSettingsPage(
    shownSettingsPage({ view: "workspace", page: "issue-vms" })!,
  );
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

test("an issue VM Paws could not delete shows its failure, and none shows no section", async () => {
  expect((await mount()).querySelector("[data-vm-delete-failing]")).toBeNull();
  failingDeletes = [
    { id: "01KVM", itemId: "PAS-9", memberUserId: "user-2", failure: "The VM host refused" },
  ];
  const root = await mount(false);
  const row = root.querySelector('[data-vm-delete-failing="01KVM"]');
  expect(row?.textContent).toBe("01KVM for PAS-9 (Robin): The VM host refused");
  expect(row?.closest('[role="alert"]')?.textContent).toContain("keeps retrying");
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
  expect(root.querySelector("#issue-vm-grant-member")).toBeNull();
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

test("an admin sees spend against the limit and saves the limit and prices", async () => {
  const root = await mount();
  const bar = root.querySelector("progress")!;
  expect([bar.getAttribute("value"), bar.getAttribute("max")]).toEqual(["40", "50"]);
  expect(bar.className).toContain("high");
  expect(root.textContent).toContain("$40.00 of $50.00 spent in 2026-11");
  expect(root.textContent).toContain("No cloud issue VMs until a price is set");
  type(root, "#issue-vm-spend-limit", "80");
  type(root, "#issue-vm-price-instabox", "0.25");
  await submit(root, "[data-spend]");
  expect(calls.find((call) => call.path.endsWith("/spend") && call.method === "PUT")?.body).toEqual(
    { monthlyLimitUsd: 80, prices: { boat: 0.12, instabox: 0.25 } },
  );
  expect(root.textContent).toContain("Spend settings saved.");
  expect(root.textContent).toContain("$40.00 of $80.00");
  expect(root.querySelector<HTMLInputElement>("#issue-vm-price-instabox")!.value).toBe("0.25");
  expect(root.textContent).not.toContain("No cloud issue VMs until a price is set");
  type(root, "#issue-vm-spend-limit", "");
  await submit(root, "[data-spend]");
  expect(root.querySelector('[role="alert"]')?.textContent).toBe(
    "Enter the monthly limit and each price in US dollars.",
  );
});

test("an admin saves the snapshot each cloud provider starts issue VMs from", async () => {
  const root = await mount();
  expect(root.textContent).toContain("No cloud issue VMs until a snapshot is set");
  type(root, "#issue-vm-snapshot-boat", " paws-base ");
  await submit(root, "[data-snapshots]");
  expect(calls.find((call) => call.path.endsWith("/spend") && call.method === "PUT")?.body).toEqual(
    { snapshots: { boat: "paws-base", instabox: null } },
  );
  expect(root.textContent).toContain("Snapshots saved.");
  expect(root.querySelector<HTMLInputElement>("#issue-vm-snapshot-boat")!.value).toBe("paws-base");
  expect(root.textContent).toContain("$40.00 of $50.00");
});

test("a price the browser could not read is refused, not skipped", async () => {
  const root = await mount();
  const price = root.querySelector<HTMLInputElement>("#issue-vm-price-boat")!;
  price.value = "";
  Object.defineProperty(price, "validity", { value: { badInput: true } });
  await submit(root, "[data-spend]");
  expect(root.querySelector('[role="alert"]')?.textContent).toBe(
    "Enter the monthly limit and each price in US dollars.",
  );
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
});

test("a member sees the spend and prices without a form", async () => {
  const root = await mount(false);
  expect(root.textContent).toContain("$40.00 of $50.00 spent in 2026-11");
  expect(root.querySelector('[data-price="boat"]')?.textContent).toBe("boat: $0.12 an hour");
  expect(root.querySelector('[data-price="instabox"]')?.textContent).toBe(
    "InstaBox: No cloud issue VMs until a price is set",
  );
  expect(root.querySelector("[data-spend]")).toBeNull();
  expect(root.querySelector("[data-snapshots]")).toBeNull();
});

test("a member refused the spend sees the rest of the page and no error", async () => {
  failing.add("GET /api/settings/issue-vm/spend");
  const root = await mount(false);
  expect(root.querySelector("progress")).toBeNull();
  expect(root.querySelector('[role="alert"]')).toBeNull();
  expect(root.textContent).toContain("Robin");
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

test("members may open Issue VMs but no other workspace page", () => {
  setSettingsAdmin(false);
  expect(shownSettingsPage({ view: "workspace", page: "issue-vms" })).toBe("issue-vms");
  expect(shownSettingsPage({ view: "workspace", page: "merging" })).toBe("account");
  expect(settingsRedirect("/workspace/issue-vms")).toBeNull();
  expect(settingsRedirect("/settings/issue-vms")).toBe("/workspace/issue-vms");
  expect(settingsRedirect("/workspace/merging")).toBe("/settings/account");
  expect(renderSettingsPage("issue-vms")).toContain('id="issue-vm-settings"');
});

test("a rejected grant keeps the chosen member, and a saved one clears the form", async () => {
  others = [{ ...member(), userId: "user-3", name: "Sam" }];
  const root = await mount();
  const select = () => root.querySelector<HTMLSelectElement>("#issue-vm-grant-member")!;
  select().value = "user-3";
  select().dispatchEvent(new window.Event("change", { bubbles: true }) as never);
  type(root, "#issue-vm-grant-limit", "99");
  type(root, "#issue-vm-grant-ends", "2099-01-31");
  await submit(root, "[data-grant]");
  expect(root.querySelector('[role="alert"]')?.textContent).toContain("from 1 to 50");
  expect(select().value).toBe("user-3");
  type(root, "#issue-vm-grant-limit", "5");
  await submit(root, "[data-grant]");
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts.map((call) => (call.body as { memberUserId: string }).memberUserId)).toEqual([
    "user-3",
    "user-3",
  ]);
  expect(root.querySelector<HTMLInputElement>("#issue-vm-grant-limit")!.value).toBe("");
  expect(root.querySelector<HTMLInputElement>("#issue-vm-grant-ends")!.value).toBe("");
});

test("a blank limit is refused before it can reset the saved value", async () => {
  const root = await mount();
  type(root, "#issue-vm-workspaceMax", "");
  await submit(root, "[data-limits]");
  expect(root.querySelector('[role="alert"]')?.textContent).toBe(
    "Enter a whole number for each limit.",
  );
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
});

function choose(root: HTMLElement, selector: string, value: string) {
  root.querySelector<HTMLSelectElement>(selector)!.value = value;
}

test("an admin saves a boat size, an InstaBox size and exe.dev CPU and memory", async () => {
  const root = await mount();
  choose(root, "#vm-size-boat", "4/8");
  await submit(root, '[data-vm-size="boat"]');
  expect(root.textContent).toContain("boat size saved.");
  choose(root, "#vm-size-instabox", "2/4");
  await submit(root, '[data-vm-size="instabox"]');
  type(root, "#vm-size-cpu", "6");
  type(root, "#vm-size-memoryGb", "12");
  await submit(root, '[data-vm-size="exe-dev"]');
  expect(sizes).toEqual({
    "exe-dev": { cpu: 6, memoryGb: 12 },
    boat: { cpu: 4, memoryGb: 8 },
    instabox: { cpu: 2, memoryGb: 4 },
  });
  expect(root.querySelector<HTMLSelectElement>("#vm-size-boat")!.value).toBe("4/8");
  expect(root.querySelector<HTMLInputElement>("#vm-size-cpu")!.value).toBe("6");
  type(root, "#vm-size-cpu", "-1");
  await submit(root, '[data-vm-size="exe-dev"]');
  expect(root.querySelector('[role="alert"]')?.textContent).toBe("cpu must be a positive integer");
});

test("an admin turns a provider off, and InstaBox without a key shows the route's message", async () => {
  instaBoxKey = false;
  const root = await mount();
  expect(root.querySelector('[data-vm-note="instabox"]')?.textContent).toBe(
    "Save an InstaBox key to list sizes",
  );
  const toggle = root.querySelector<HTMLInputElement>('[data-vm-on="boat"]')!;
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }) as never);
  await settle();
  expect(offProviders).toEqual(["boat"]);
  expect(root.querySelector<HTMLInputElement>('[data-vm-on="boat"]')!.checked).toBe(false);
  expect(root.textContent).toContain("boat is off for new VMs.");
});

test("a member sees each provider's VM size without a form", async () => {
  sizes = { "exe-dev": { cpu: 6, memoryGb: 12, pool: "main" }, boat: {}, instabox: {} };
  offProviders = ["instabox"];
  const root = await mount(false);
  expect([...root.querySelectorAll("[data-vm-row]")].map((row) => row.textContent)).toEqual([
    "exe.dev: 6 vCPUs · 12 GB · Default pool main, on",
    "boat: Provider default, on",
    "InstaBox: Provider default, off",
  ]);
});

test("the old Member VMs page opens the VM sizes section", () => {
  for (const admin of [true, false]) {
    setSettingsAdmin(admin);
    expect(settingsRedirect("/workspace/member-vm")).toBe("/workspace/issue-vms#vm-sizes");
    expect(settingsRedirect("/settings/member-vm")).toBe("/workspace/issue-vms#vm-sizes");
  }
});
