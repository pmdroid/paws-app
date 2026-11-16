import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { SettingsPage } from "./settings-pages";
import { settleReactWork } from "./settle-react";
import { initializeWorkspaceAccess, showWorkspaceSettingsPage } from "./workspace";

const GLOBALS = ["window", "document", "location", "sessionStorage", "HTMLElement", "Event"];
const GITHUB = [
  "/api/workspaces/github-app",
  "/api/workspaces/github-connect",
  "/api/workspaces/repositories",
];
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;
let requests: string[];

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/dashboard/settings/account" });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.body.innerHTML = '<section id="workspace-access" hidden></section>';
  requests = [];
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

function serve(role: string) {
  globalThis.fetch = (async (url: URL | string) => {
    const path = String(url).split("?")[0]!;
    requests.push(path);
    if (path === "/api/auth/session")
      return Response.json({
        role,
        workspaceId: "w",
        csrfToken: "t",
        workspaces: [{ id: "w", name: "Acme", role }],
        setup: { complete: true },
      });
    if (path === "/api/workspaces/github-app") return Response.json({ configured: true });
    if (path === "/api/workspaces/github-connect")
      return Response.json({ status: "connected", repositoryCount: 1, lastDelivery: null });
    if (path === "/api/workspaces/github-setup")
      return Response.json({
        signedIn: true,
        cached: true,
        installationId: "7",
        repositories: [{ repository: "acme/api", private: true }],
        teams: [{ id: "t1", name: "Core", key: "COR" }],
        mappings: [{ repository: "acme/api", teamId: "t1" }],
        refreshedAt: Date.now(),
      });
    if (path === "/api/workspaces/repositories")
      return Response.json({ repositories: [{ repository: "acme/api", teamId: "t1" }] });
    return Response.json({});
  }) as typeof fetch;
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("a member's Settings pages make no workspace GitHub request, even after a window focus", async () => {
  serve("member");
  const pages: SettingsPage[] = ["account", "agent-accounts"];
  expect(await initializeWorkspaceAccess(() => pages[0]!)).toBe(true);
  await settle();
  for (const page of pages) {
    showWorkspaceSettingsPage(page);
    window.dispatchEvent(new window.Event("focus"));
    await settle();
  }
  expect(requests).toContain("/api/auth/session");
  expect(requests.filter((path) => GITHUB.includes(path))).toEqual([]);
  expect(window.document.querySelector("#workspace-github-integration")).toBeNull();
});

test("an admin loads the GitHub section only on Workspace › Integrations", async () => {
  serve("admin");
  expect(await initializeWorkspaceAccess(() => "account")).toBe(true);
  window.dispatchEvent(new window.Event("focus"));
  await settle();
  expect(requests.filter((path) => GITHUB.includes(path))).toEqual([]);
  showWorkspaceSettingsPage("integrations");
  await settle();
  expect(requests).toContain("/api/workspaces/github-app");
  expect(requests).toContain("/api/workspaces/github-setup");
  const section = window.document.querySelector("#workspace-github-integration");
  expect(section?.hasAttribute("hidden")).toBe(false);
  expect(
    [...window.document.querySelectorAll('input[name="mapping"]')].map((box) =>
      box.getAttribute("data-repository"),
    ),
  ).toEqual(["acme/api"]);
});
