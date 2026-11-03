import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createAccountSettings, type AgentAccounts } from "./account-settings";

const realFetch = globalThis.fetch;
const DOM_GLOBALS = [
  "window",
  "navigator",
  "Node",
  "Element",
  "Event",
  "MouseEvent",
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
let requests: { url: string; init: RequestInit; respond: (response: Response) => void }[];

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/settings/agents" });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  globalThis.fetch = ((url: URL | string, init: RequestInit) =>
    new Promise<Response>((respond) =>
      requests.push({ url: String(url), init, respond }),
    )) as unknown as typeof fetch;
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ACCOUNT = "01J00000000000000000000AAA";

function list(revision: string, enabled: boolean, label = "Team A"): AgentAccounts {
  return {
    revision,
    canManage: true,
    agents: [{ agent: "claude", name: "Claude", unsupported: null }],
    runners: [],
    accounts: [
      {
        id: ACCOUNT,
        agent: "claude",
        label,
        legacy: false,
        enabled,
        concurrency: null,
        running: 0,
        sharedLimit: false,
        bindings: [],
      },
    ],
  };
}

function click(root: HTMLElement, action: string) {
  root
    .querySelector<HTMLButtonElement>(`[data-account-action="${action}"]`)!
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

test("a stale write is refused, the page reloads the newer accounts and keeps the reason", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as never);
  const changed: number[] = [];
  createAccountSettings(() => changed.push(1)).mount(root, "http://127.0.0.1:8787");
  expect(requests[0]!.url).toBe("http://127.0.0.1:8787/api/runners/accounts");
  requests[0]!.respond(Response.json(list("rev-1", true)));
  await settle();
  expect(root.textContent).toContain("Team A");

  click(root, "disable");
  click(root, "disable");
  expect(requests).toHaveLength(2);
  expect(requests[1]!.init.method).toBe("POST");
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ enabled: false, revision: "rev-1" });
  expect((requests[1]!.init.headers as Record<string, string>)["x-paws-csrf"]).toBe("token-1");
  requests[1]!.respond(
    Response.json(
      { error: "Agent accounts changed since this page loaded.", revision: "rev-2" },
      { status: 409 },
    ),
  );
  await settle();
  expect(requests).toHaveLength(3);
  expect(requests[2]!.url).toBe("http://127.0.0.1:8787/api/runners/accounts");
  requests[2]!.respond(Response.json(list("rev-2", true, "Team A (renamed)")));
  await settle();
  expect(root.textContent).toContain("Team A (renamed)");
  expect(root.textContent).toContain("Agent accounts changed since this page loaded.");
  expect(changed).toEqual([]);

  click(root, "disable");
  expect(JSON.parse(String(requests[3]!.init.body)).revision).toBe("rev-2");
  requests[3]!.respond(Response.json(list("rev-3", false, "Team A (renamed)")));
  await settle();
  expect(root.textContent).toContain("new work skips it");
  expect(changed).toEqual([1]);
});

test("a failed load offers a retry and shows no partial state", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as never);
  createAccountSettings().mount(root, "http://127.0.0.1:8787");
  requests[0]!.respond(
    Response.json({ error: "Workspace access is unavailable." }, { status: 403 }),
  );
  await settle();
  expect(root.textContent).toContain("Workspace access is unavailable.");
  click(root, "reload");
  expect(requests).toHaveLength(2);
});
