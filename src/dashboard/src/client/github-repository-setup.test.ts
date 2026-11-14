import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { initializeGitHubRepositorySetup } from "./github-repository-setup";
import { settingsPageShown } from "./settings-loads";
import { initializeWorkspaceGitHub } from "./workspace-github";

const GLOBALS = ["window", "document", "sessionStorage", "HTMLElement", "Event"];
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;
let puts: unknown[];

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/dashboard/settings/integrations" });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  puts = [];
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

function serve(status: string, setup: Record<string, unknown>) {
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    if (String(url) === "/api/workspaces/github-connect")
      return Response.json({ status, repositoryCount: 2, lastDelivery: null });
    if (init?.method === "PUT") puts.push(JSON.parse(String(init.body)));
    return Response.json(setup);
  }) as typeof fetch;
}

async function mount(member = false) {
  const root = window.document.createElement("div");
  window.document.body.append(root as never);
  if (member) initializeWorkspaceGitHub(root as unknown as HTMLElement, "t");
  else initializeGitHubRepositorySetup(root as unknown as HTMLElement, "t");
  settingsPageShown("integrations");
  for (
    let i = 0;
    i < 20 && !root.querySelector("[data-badge] .pill, [data-login], [data-github-repositories] li");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 5));
  return root;
}

test("a connected workspace shows the Connected badge and the cached selector without sign-in or refresh", async () => {
  serve("connected", {
    signedIn: true,
    cached: true,
    installationId: "7",
    repositories: [
      { repository: "acme/api", private: true },
      { repository: "acme/web", private: false },
    ],
    teams: [{ id: "t1", name: "Core", key: "COR" }],
    mappings: [{ repository: "acme/api", teamId: "t1" }],
    refreshedAt: Date.now(),
  });
  const root = await mount();
  expect(root.querySelector("[data-badge] .pill")?.textContent).toBe("Connected");
  expect(root.querySelector("[data-badge]")?.textContent).toContain("acme");
  expect(root.querySelector("[data-status]")?.textContent).toContain("Updated just now.");
  expect(root.querySelector("[data-login],[data-refresh],[data-install]")).toBeNull();
  expect(root.textContent).not.toContain("Signed in as");
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input[name="mapping"]')];
  expect(boxes.map((box) => [box.dataset.repository, box.checked])).toEqual([
    ["acme/api", true],
    ["acme/web", false],
  ]);
  boxes[1]!.click();
  root
    .querySelector("form")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(puts).toEqual([
    {
      installationId: "7",
      mappings: [
        { repository: "acme/api", teamId: "t1" },
        { repository: "acme/web", teamId: "t1" },
      ],
    },
  ]);
});

test("a workspace without GitHub keeps Sign in with GitHub", async () => {
  serve("needs_connection", { signedIn: false, mappings: [] });
  const root = await mount();
  expect(root.querySelector("[data-login]")?.textContent).toBe("Sign in with GitHub");
  expect(root.querySelector("[data-badge] .pill")).toBeNull();
});

test("a member of a connected workspace sees the badge and the mapped repositories read-only", async () => {
  serve("connected", {
    repositories: [
      { repository: "acme/api", teamId: "t1" },
      { repository: "acme/api", teamId: "t2" },
      { repository: "acme/web", teamId: "t1" },
    ],
  });
  const root = await mount(true);
  expect(root.querySelector("[data-github-status] .pill")?.textContent).toBe("Connected");
  expect(root.querySelector("[data-github-status]")?.textContent).toContain("acme");
  expect(
    [...root.querySelectorAll("[data-github-repositories] li")].map((li) => li.textContent),
  ).toEqual(["acme/api", "acme/web"]);
  expect(
    root.querySelector("input, select, [data-github-refresh], [data-github-connect]"),
  ).toBeNull();
});
