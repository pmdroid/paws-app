import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CheckoutSettings, CheckoutSettingsUpdate } from "../checkout-settings";
import { createCheckoutSettings } from "./checkout-settings";
import { initializeWorkspaceAccess, showWorkspaceSettingsPage } from "./workspace";
import { settleReactWork } from "./settle-react";

const realFetch = globalThis.fetch;
const DOM_GLOBALS = [
  "window",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
  "Node",
  "Element",
  "Event",
  "MouseEvent",
  "SubmitEvent",
  "document",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "CSS",
] as const;
const saved = new Map<string, unknown>();
let window: Window;
let puts: CheckoutSettingsUpdate[];
let status: number;

function settings(): CheckoutSettings {
  return {
    label: "paws:full-checkout",
    repositories: [
      {
        repo: "pmdroid/paws-app",
        paths: [{ path: "docs/archive/", hideFrom: "agent", usedBy: [] }],
      },
    ],
  };
}

function json(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/settings/workspace" });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="">';
  window.document.body.innerHTML =
    '<main><div id="page-content"></div><section id="workspace-access" hidden></section></main>';
  puts = [];
  status = 200;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url), "http://127.0.0.1:8787").pathname;
    if (path === "/api/auth/session")
      return status === 200
        ? json({
            userId: "user-1",
            role: "admin",
            user: { name: "Ada", email: "ada@example.com" },
            workspaceId: "ws-1",
            csrfToken: "token-1",
            workspaces: [{ id: "ws-1", name: "Acme", role: "admin" }],
          })
        : json({}, status);
    if (path === "/api/settings/checkout") {
      if (init?.method !== "PUT") return json(settings());
      const body = JSON.parse(String(init.body)) as CheckoutSettingsUpdate;
      puts.push(body);
      return json({
        label: "paws:full-checkout",
        repositories: body.repositories.map((repository) => ({
          repo: repository.repo,
          paths: repository.paths.map((entry) => ({ ...entry, usedBy: [] })),
        })),
      });
    }
    return json({ error: "Not in this test." }, 500);
  }) as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 20));
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function sectionHeadings(): string[] {
  return [
    ...window.document.querySelectorAll(
      '#workspace-access [data-settings-page="workspace"]:not([hidden]) h2',
    ),
  ].map((heading) => heading.textContent ?? "");
}

test("Workspace access shows Repository checkout after repository access", async () => {
  expect(await initializeWorkspaceAccess(() => "workspace")).toBe(true);
  const root = window.document.querySelector("#checkout-settings") as unknown as HTMLElement;
  createCheckoutSettings().mount(root, "http://127.0.0.1:8787");
  await settle();
  expect(sectionHeadings()).toEqual(["Members", "Repositories", "Repository checkout"]);
  showWorkspaceSettingsPage("agents");
  expect(root.hidden).toBe(true);
});

test("without workspace sign-in, Workspace access still shows Repository checkout", async () => {
  status = 404;
  expect(await initializeWorkspaceAccess(() => "workspace")).toBe(true);
  const root = window.document.querySelector("#checkout-settings") as unknown as HTMLElement;
  expect(root.hidden).toBe(false);
  createCheckoutSettings().mount(root, "http://127.0.0.1:8787");
  await settle();
  expect(root.textContent).toContain("docs/archive/");
});

test("adding and removing a hidden path on Workspace access saves the new paths", async () => {
  await initializeWorkspaceAccess(() => "workspace");
  const root = window.document.querySelector("#checkout-settings") as unknown as HTMLElement;
  createCheckoutSettings().mount(root, "http://127.0.0.1:8787");
  await settle();
  const input = root.querySelector<HTMLInputElement>('[name="checkout-add"]')!;
  input.value = "docs/plans/";
  root
    .querySelector("form.checkout-add")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
  root
    .querySelector<HTMLButtonElement>('[data-checkout="remove"][data-index="0"]')!
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as never);
  root
    .querySelector<HTMLButtonElement>('[data-checkout="save"]')!
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as never);
  await settle();
  expect(puts).toEqual([
    {
      repositories: [
        { repo: "pmdroid/paws-app", paths: [{ path: "docs/plans/", hideFrom: "agent" }] },
      ],
    },
  ]);
  expect(root.textContent).toContain("Saved.");
  expect(root.textContent).not.toContain("docs/archive/");
});
