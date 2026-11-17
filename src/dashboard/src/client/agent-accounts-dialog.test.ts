import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { openAgentAccounts } from "./agent-accounts";

const globals = ["window", "document", "Node", "Element", "HTMLElement"] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
let window: Window;
let fail: boolean;
let release: (response: Response) => void;
let session = login("");
function login(terminal: string) {
  return {
    id: "login",
    agent: "claude",
    state: "waiting",
    startedAt: 0,
    expiresAt: 60000,
    terminal,
    authorization: null,
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const query = (selector: string) => window.document.querySelector(selector)!;

beforeEach(() => {
  window = new Window();
  for (const key of globals) {
    saved.set(key, globalThis[key]);
    Object.assign(globalThis, { [key]: key === "window" ? window : window[key] });
  }
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  session = login("");
  fail = false;
  globalThis.fetch = (async (_path, init) => {
    if (init?.method === "POST") {
      if (fail) return Response.json({ error: "Runner disconnected" }, { status: 503 });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    return Response.json({ bindings: [{ bindingId: "binding", agent: session.agent, session }] });
  }) as typeof fetch;
});
afterEach(() => {
  window.close();
  globalThis.fetch = realFetch;
  for (const key of globals) Object.assign(globalThis, { [key]: saved.get(key) });
});

test("account sign-in names the account and explains runner sharing", async () => {
  openAgentAccounts(
    { id: "runner", name: "goldbox" },
    "claude",
    () => {},
    "binding",
    "Team <work>",
  );
  await settle();
  expect(query("h2").textContent).toBe("Sign in to Claude for Team <work>");
  expect(window.document.body.textContent).toContain(
    "Paws runs the sign-in on goldbox; the account is saved for all your runners.",
  );
});

test("reply progress survives an unchanged response until a session update; failures show feedback", async () => {
  openAgentAccounts({ id: "runner", name: "goldbox" }, "claude", () => {}, "binding", "Team");
  await settle();
  const submit = () => {
    (query("input") as unknown as HTMLInputElement).value = "code";
    query("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };
  submit();
  expect(query("[data-account-progress]").textContent).toBe("Sending your reply to Claude…");
  release(Response.json(session));
  await settle();
  expect(query("[data-account-progress]").textContent).toBe("Sending your reply to Claude…");
  session = login("Signed in");
  (query("[data-account-refresh]") as unknown as HTMLButtonElement).click();
  await settle();
  expect(query("[data-account-progress]").textContent).toBe("");
  fail = true;
  submit();
  await settle();
  expect(query("[data-account-feedback]").textContent).toBe("Runner disconnected");
  expect(query("[data-account-progress]").textContent).toBe("");
});

test("OpenCode's device sign-in shows its code instead of the terminal; a failure shows why", async () => {
  session = {
    ...login(
      "\u001b[34m●\u001b[39m  Enter code: PJNS-PWFC\r\n●  https://opencode.ai/console/device?user_code=PJNS-PWFC\r\n",
    ),
    agent: "opencode",
  };
  openAgentAccounts({ id: "runner", name: "goldbox" }, "opencode", () => {}, "binding", "Team");
  await settle();
  expect(query("[data-agent-code]").textContent).toBe("PJNS-PWFC");
  expect(query("[data-agent-copy]").textContent).toBe("Copy code");
  expect(query("[data-agent-open]").getAttribute("href")).toBe(
    "https://opencode.ai/console/device?user_code=PJNS-PWFC",
  );
  expect((query("[data-agent-terminal]") as unknown as HTMLElement).hidden).toBe(true);
  expect((query("[data-agent-input]") as unknown as HTMLElement).hidden).toBe(true);
  session = { ...session, state: "failed", terminal: "Error: device code expired" };
  (query("[data-account-refresh]") as unknown as HTMLButtonElement).click();
  await settle();
  expect(window.document.querySelector("[data-agent-code]")).toBeNull();
  expect((query("[data-agent-terminal]") as unknown as HTMLElement).hidden).toBe(false);
  expect(query("[data-agent-terminal]").textContent).toBe("Error: device code expired");
  session = { ...session, terminal: "" };
  (query("[data-account-refresh]") as unknown as HTMLButtonElement).click();
  await settle();
  expect((query("[data-agent-terminal]") as unknown as HTMLElement).hidden).toBe(true);
});
