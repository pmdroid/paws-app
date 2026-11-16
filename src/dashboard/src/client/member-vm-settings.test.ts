import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createMemberVmSettings } from "./member-vm-settings";
import { renderSettingsPage, setSettingsAdmin, shownSettingsPage } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const ENGINE = "http://127.0.0.1:8787";
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;
let puts: unknown[];
let size: Record<string, unknown>;

beforeEach(() => {
  window = new Window({ url: `${ENGINE}/settings/member-vm` });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  puts = [];
  size = { cpu: 4, memoryGb: 8 };
  globalThis.fetch = (async (_url: URL | string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      if (body.cpu < 1)
        return Response.json({ error: "CPUs must be a positive integer." }, { status: 400 });
      size = body;
    }
    return Response.json(size);
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

async function mount() {
  setSettingsAdmin(true);
  window.document.body.innerHTML = renderSettingsPage("member-vm");
  const root = window.document.querySelector("#member-vm-settings") as unknown as HTMLElement;
  createMemberVmSettings().mount(root, ENGINE);
  await settle();
  return root;
}

async function submit(root: HTMLElement, cpu: string) {
  const input = root.querySelector<HTMLInputElement>("#vm-size-cpu")!;
  input.value = cpu;
  input.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true }) as never);
  await settle();
}

test("an admin edits member VM size on its Settings page", async () => {
  const root = await mount();
  expect(root.querySelector<HTMLInputElement>("#vm-size-cpu")!.value).toBe("4");
  expect(root.querySelector<HTMLInputElement>("#vm-size-diskGb")!.value).toBe("");
  await submit(root, "6");
  expect(puts).toEqual([{ cpu: 6, memoryGb: 8 }]);
  expect(root.textContent).toContain("Member VM size saved.");
});

test("a rejected size keeps the typed value and shows the server's message", async () => {
  const root = await mount();
  await submit(root, "-1");
  expect(root.querySelector('[role="alert"]')?.textContent).toContain(
    "CPUs must be a positive integer.",
  );
  expect(root.querySelector<HTMLInputElement>("#vm-size-cpu")!.value).toBe("-1");
});

test("Member VMs is an admin page", () => {
  setSettingsAdmin(false);
  expect(shownSettingsPage({ view: "workspace", page: "member-vm" })).toBe("account");
  setSettingsAdmin(true);
  expect(shownSettingsPage({ view: "workspace", page: "member-vm" })).toBe("member-vm");
});
