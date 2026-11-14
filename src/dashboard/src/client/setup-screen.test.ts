import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { settleReactWork } from "./settle-react";
import { initializeWorkspaceAccess } from "./workspace";

const GLOBALS = ["window", "document", "location", "sessionStorage", "HTMLElement", "Event"];
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/dashboard/settings/merging" });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.body.innerHTML =
    '<div id="top"></div><div id="banner"></div><div id="page-content"></div><section id="workspace-access" hidden></section>';
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

function respond(response: Response) {
  globalThis.fetch = (async (url: URL | string) =>
    String(url) === "/api/auth/session"
      ? response.clone()
      : Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch;
}

const session = (role: string, complete: boolean) =>
  Response.json({
    role,
    workspaceId: "w",
    csrfToken: "t",
    workspaces: [],
    setup: { repositories: complete ? 1 : 0, complete },
  });

test("an admin of an unfinished setup sees only the setup steps with the Integrations GitHub component", async () => {
  respond(session("admin", false));
  expect(await initializeWorkspaceAccess(() => null)).toBe(false);
  const content = window.document.querySelector("#page-content")!;
  expect([...content.querySelectorAll("[data-setup-step] b")].map((b) => b.textContent)).toEqual([
    "Linear connected",
    "Connect GitHub",
    "Choose repositories",
  ]);
  expect(content.querySelector('[data-setup-step="done"] b')?.textContent).toBe("Linear connected");
  expect(content.querySelector('[data-setup-step="next"] span.muted')?.textContent).toBe(
    "Paws's GitHub App must be installed on the organization or account whose repositories it will work on. Installing it needs an owner of that organization; connecting it here needs only read access to those repositories.",
  );
  expect(content.querySelector("[data-setup-github] #workspace-github-integration")).not.toBeNull();
  expect(window.document.querySelector("#top")!.hasAttribute("hidden")).toBe(true);
  expect(window.document.querySelector("#workspace-access")!.hasAttribute("hidden")).toBe(true);
});

test("a member of an unfinished setup sees only the waiting message and sign-out", async () => {
  respond(session("member", false));
  expect(await initializeWorkspaceAccess(() => null)).toBe(false);
  const content = window.document.querySelector("#page-content")!;
  expect(content.querySelector("p")?.textContent).toBe(
    "An admin is still setting up Paws. You'll be able to use it once GitHub is connected.",
  );
  expect(content.querySelector("[data-setup-signout]")?.textContent).toBe("Sign out");
  expect(content.querySelector("[data-setup-step], #workspace-github-integration")).toBeNull();
});

test("a finished setup opens the dashboard", async () => {
  respond(session("member", true));
  expect(await initializeWorkspaceAccess(() => null)).toBe(true);
  expect(window.document.querySelector("[data-setup-screen]")).toBeNull();
});

test("the sign-in page states both roles before sign-in", async () => {
  respond(Response.json({ configured: true }, { status: 401 }));
  expect(await initializeWorkspaceAccess(() => null)).toBe(false);
  expect(window.document.querySelector("#page-content")?.textContent).toContain(
    "To set up Paws you need to be an admin of your Linear workspace. Paws's GitHub App must be installed on the GitHub organization or account whose repositories it will work on; installing it needs an owner of that organization. After setup, other people only need to sign in with Linear.",
  );
});
