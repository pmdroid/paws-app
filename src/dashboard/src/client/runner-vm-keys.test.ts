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

async function mount(status: { exeDev: boolean; tailscale: boolean }) {
  for (const name of GLOBALS)
    global[name] = name === "window" ? window : (window as unknown as typeof global)[name];
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  const calls: unknown[][] = [];
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push([init?.method, String(url), init?.body && JSON.parse(String(init.body))]);
    if (init?.method === "PUT") status = { ...status, tailscale: true };
    if (init?.method === "DELETE") status = { ...status, tailscale: false };
    return Response.json(status);
  }) as typeof fetch;
  setSettingsAdmin(true);
  window.document.body.innerHTML = renderSettingsPage("runner-vms");
  const root = window.document.querySelector("#runner-vm-keys") as unknown as HTMLElement;
  createRunnerVmKeys().mount(root, ENGINE);
  await settle();
  const states = () => [...root.querySelectorAll("[data-key-state]")].map((n) => n.textContent);
  return { root, calls, states };
}

test("shows both keys as not set with password fields and the Tailscale requirements", async () => {
  const { root, states } = await mount({ exeDev: false, tailscale: false });
  expect(window.document.querySelector("h1")?.textContent).toBe("Runner VMs");
  expect(states()).toEqual(["Not set", "Not set"]);
  expect([...root.querySelectorAll("input")].every((input) => input.type === "password")).toBe(
    true,
  );
  expect(root.querySelector("[data-clear]")).toBeNull();
  for (const text of [
    "reusable and pre-authorized",
    "tag:paws-runner",
    '"dst": ["paws:8787,8788"]',
  ])
    expect(root.textContent).toContain(text);
});

test("saving a key shows it set, and Clear removes it", async () => {
  const { root, calls, states } = await mount({ exeDev: true, tailscale: false });
  expect(states()).toEqual(["Set", "Not set"]);
  const input = root.querySelector<HTMLInputElement>("#runner-vm-tailscale")!;
  input.value = "tskey-auth-1";
  input.form!.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }) as never,
  );
  await settle();
  const path = `${ENGINE}/api/settings/runner-vm-keys`;
  expect(calls[1]).toEqual(["PUT", path, { tailscale: "tskey-auth-1" }]);
  expect(states()).toEqual(["Set", "Set"]);
  expect(root.textContent).not.toContain("tskey-auth-1");
  root.querySelector<HTMLButtonElement>('[data-clear="tailscale"]')!.click();
  await settle();
  expect(calls[2]).toEqual(["DELETE", `${path}?key=tailscale`, undefined]);
  expect(states()).toEqual(["Set", "Not set"]);
  expect(root.textContent).toContain("Cleared.");
});
