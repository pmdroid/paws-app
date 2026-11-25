import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRunnerVmKeys } from "./runner-vm-keys";
import { renderSettingsPage, setSettingsAdmin } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const ENGINE = "http://127.0.0.1:8787";
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
const global = globalThis as Record<string, unknown>;
const saved = Object.fromEntries(GLOBALS.map((name) => [name, global[name]]));
const realFetch = globalThis.fetch;
const window = new Window({ url: `${ENGINE}/workspace/runner-vms` });
afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  Object.assign(global, saved);
});

const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  await settleReactWork();
};

type Check = { state: string; message: string; facts: unknown[]; checkedAt: number };
type Vm = { vmName: string; runnerId: string | null; step: string };
type Entry = { set: boolean; off?: boolean; vms?: Vm[]; check: Check | null };
type Status = Record<"exe-dev" | "boat" | "instabox" | "tailscale", Entry> & {
  nextCheckAt: number | null;
};
const check = (state: string, message = `${state} message`): Check => ({
  state,
  message,
  facts: [{ name: "key", text: `${state} fact`, level: state === "working" ? "ok" : "error" }],
  checkedAt: Date.now() - 120_000,
});
const none = (): Status => ({
  "exe-dev": { set: false, off: false, check: null },
  boat: { set: false, off: false, check: null },
  instabox: { set: false, off: false, check: null },
  tailscale: { set: false, check: null },
  nextCheckAt: null,
});

async function mount(status: Status, onSave?: (body: Record<string, string>) => Check | null) {
  for (const name of GLOBALS)
    global[name] = name === "window" ? window : (window as unknown as typeof global)[name];
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  const calls: unknown[][] = [];
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const { pathname, search } = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push([method, pathname + search, body]);
    if (pathname === "/api/runners")
      return Response.json({
        runners: [
          {
            id: "r1",
            name: "boat-runner",
            status: "active",
            metrics: { cpuCount: 4, memoryTotalBytes: 8 * 1024 ** 3 },
          },
        ],
      });
    if (pathname === "/api/runners/vm") return Response.json({ available: false });
    if (pathname === "/api/settings/vm-providers/check")
      status = {
        ...status,
        [body.key]: { ...status[body.key as "boat"], check: check("working") },
      };
    if (pathname === "/api/settings/vm-providers" && method === "PUT")
      status = {
        ...status,
        [body.provider]: { ...status[body.provider as "boat"], off: body.off },
      };
    if (pathname === "/api/settings/runner-vm-keys" && method === "PUT") {
      const [key] = Object.keys(body);
      const name = key === "exeDev" ? "exe-dev" : (key as "boat");
      const result = onSave?.(body) ?? null;
      status = { ...status, [name]: { ...status[name], set: true, check: result } };
      return Response.json({ check: result });
    }
    if (pathname === "/api/settings/runner-vm-keys" && method === "DELETE") {
      const key = new URLSearchParams(search).get("key");
      const name = key === "exeDev" ? "exe-dev" : (key as "boat");
      status = { ...status, [name]: { ...status[name], set: false, check: null } };
      return Response.json({});
    }
    return Response.json(status);
  }) as typeof fetch;
  setSettingsAdmin(true);
  window.document.body.innerHTML = renderSettingsPage("runner-vms");
  const root = window.document.querySelector("#runner-vm-keys") as unknown as HTMLElement;
  createRunnerVmKeys().mount(root, ENGINE);
  await settle();
  const card = (name: string) => root.querySelector(`[data-vm-provider="${name}"]`)!;
  const badge = (name: string) => card(name).querySelector("[data-provider-state]")?.textContent;
  const click = async (selector: string) => {
    root.querySelector<HTMLButtonElement>(selector)!.click();
    await settle();
  };
  return { root, calls, card, badge, click };
}

test("each provider state shows its badge with an icon and a word", async () => {
  const status = none();
  status["exe-dev"] = { set: true, off: false, check: check("working") };
  status.boat = {
    set: true,
    off: false,
    vms: [
      { vmName: "vm-1", runnerId: "r1", step: "ready" },
      { vmName: "vm-2", runnerId: null, step: "install" },
    ],
    check: check("rejected", "boat refused the key."),
  };
  status.instabox = { set: true, off: false, vms: [], check: check("unreachable") };
  status.tailscale = { set: true, check: check("limited") };
  const { root, badge, card } = await mount(status);
  expect(window.document.querySelector("h1")?.textContent).toBe("Runner VMs");
  expect(badge("exe-dev")).toBe("✓Working");
  expect(badge("boat")).toBe("✕Key rejected");
  expect(badge("instabox")).toBe("⚠Can't reach");
  expect(badge("tailscale")).toBe("!Limited");
  expect(card("boat").querySelector('[role="alert"]')?.textContent).toBe("boat refused the key.");
  expect(card("exe-dev").querySelector('[role="alert"]')).toBeNull();
  expect(card("exe-dev").textContent).toContain("working fact");
  expect(card("exe-dev").textContent).toContain("Checked 2m ago");
  expect(card("boat").textContent).toContain("boat-runner");
  expect(card("boat").textContent).toContain("4 CPUs · 8 GB");
  expect(card("boat").textContent).toContain("vm-2Size not reportedinstall");
  expect(card("instabox").textContent).toContain("No runners on InstaBox.");
  expect(card("exe-dev").textContent).toContain("Runners could not be listed.");
  expect(card("tailscale").querySelector("[data-provider-on]")).toBeNull();
  expect(card("tailscale").textContent).toContain("can't be turned off");
  expect(root.querySelector("[data-vm-summary]")?.textContent).toContain(
    "1 of 3 VM providers working.",
  );

  const off = none();
  off.boat = { set: true, off: true, check: check("working") };
  const second = await mount(off);
  expect(second.badge("boat")).toBe("○Off");
  expect(second.badge("instabox")).toBe("–Not connected");
  expect(second.card("instabox").querySelector("[data-connect-open]")?.textContent).toBe("Connect");
});

test("Check now posts to the check route and repaints the card", async () => {
  const status = none();
  status.boat = { set: true, off: false, check: check("unreachable") };
  const { calls, badge, click } = await mount(status);
  await click('[data-check="boat"]');
  expect(calls).toEqual([["POST", "/api/settings/vm-providers/check", { key: "boat" }]]);
  expect(badge("boat")).toBe("✓Working");
});

test("the switch sends PUT and shows the new state", async () => {
  const status = none();
  status.instabox = { set: true, off: false, check: check("working") };
  const { root, calls, badge } = await mount(status);
  const input = root.querySelector<HTMLInputElement>('[data-provider-on="instabox"]')!;
  expect(input.checked).toBe(true);
  input.checked = false;
  input.dispatchEvent(new window.Event("change", { bubbles: true }) as never);
  await settle();
  expect(calls).toEqual([
    ["PUT", "/api/settings/vm-providers", { provider: "instabox", off: true }],
  ]);
  expect(badge("instabox")).toBe("○Off");
  expect(root.querySelector<HTMLInputElement>('[data-provider-on="instabox"]')!.checked).toBe(
    false,
  );
  expect(root.textContent).toContain("InstaBox is off for new VMs.");
});

test("connecting a provider saves the key, shows the check result and offers the switch", async () => {
  const { root, calls, card, click } = await mount(none(), () =>
    check("working", "boat accepted the key."),
  );
  await click('[data-connect-open="boat"]');
  const input = root.querySelector<HTMLInputElement>("#runner-vm-boat")!;
  expect(input.type).toBe("password");
  expect(input.closest("[data-runner-vm-key]")?.getAttribute("data-runner-vm-key")).toBe("boat");
  input.value = "boat_secret";
  input.form!.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }) as never,
  );
  await settle();
  expect(calls).toEqual([["PUT", "/api/settings/runner-vm-keys", { boat: "boat_secret" }]]);
  const result = card("boat").querySelector("[data-connect-result]")!;
  expect(result.textContent).toContain("Working");
  expect(result.textContent).toContain("boat accepted the key.");
  expect(card("boat").querySelector('[data-provider-on="boat"]')).not.toBeNull();
  expect(card("boat").querySelector('a[href$="member-vm"]')).not.toBeNull();
  expect(root.textContent).not.toContain("boat_secret");
  await click("[data-cancel]");
  expect(card("boat").querySelector('[data-check="boat"]')).not.toBeNull();
});

test("Replace key shows the check message and Remove key disconnects", async () => {
  const status = none();
  status.tailscale = { set: true, check: null };
  status["exe-dev"] = { set: true, off: false, check: check("rejected") };
  const { root, calls, badge, click } = await mount(status, () =>
    check("working", "exe.dev accepted the key."),
  );
  expect(root.textContent).toContain("tag:paws-runner");
  await click('[data-replace="exe-dev"]');
  const input = root.querySelector<HTMLInputElement>("#runner-vm-exeDev")!;
  input.value = "exe-token";
  input.form!.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }) as never,
  );
  await settle();
  expect(calls[0]).toEqual(["PUT", "/api/settings/runner-vm-keys", { exeDev: "exe-token" }]);
  expect(badge("exe-dev")).toBe("✓Working");
  expect(root.textContent).toContain("exe.dev accepted the key.");
  await click('[data-clear="tailscale"]');
  expect(calls[1]).toEqual(["DELETE", "/api/settings/runner-vm-keys?key=tailscale", undefined]);
  expect(badge("tailscale")).toBe("–Not connected");
});
