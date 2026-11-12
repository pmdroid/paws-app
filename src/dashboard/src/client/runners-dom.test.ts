import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRunners, type Runner } from "./runners";
import { settleReactWork } from "./settle-react";

const realFetch = globalThis.fetch;
const DOM_GLOBALS = [
  "window",
  "navigator",
  "location",
  "Node",
  "Element",
  "Event",
  "MouseEvent",
  "document",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLDialogElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "CSS",
] as const;
const ORIGIN = "http://127.0.0.1:8787";
const RUNNER = "01JRUNNER0000000000000000A";
const saved = new Map<string, unknown>();
let window: Window;
let requests: { url: string; init: RequestInit | undefined }[];

const runner: Runner = {
  id: RUNNER,
  name: "build-box",
  ownerUserId: "owner",
  status: "active",
  metrics: null,
  os: null,
  version: "1.2.0",
  idle: true,
  agents: [
    { agent: "claude", status: "signed_in", checkedAt: 1 },
    { agent: "codex", status: "signed_out", checkedAt: 1 },
  ],
};

beforeEach(() => {
  window = new Window({ url: `${ORIGIN}/dashboard/runners/${RUNNER}` });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url), ORIGIN).pathname;
    requests.push({ url: path, init });
    if (path === "/api/runners") return Response.json({ runners: [runner], serverVersion: null });
    if (path === "/api/auth/session") return Response.json({ userId: "owner", role: "member" });
    if (path === `/api/runners/${RUNNER}/policy`)
      return Response.json({ ownerUserId: "owner", sharing: 0 });
    if (path === "/api/runners/usage") return Response.json({ usage: [] });
    if (path === "/api/runners/vm") return Response.json({ available: false });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 20));
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("the extra usage switch posts the runner agent's extra-usage route", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as unknown as Parameters<typeof window.document.body.append>[0]);
  createRunners().mount(root, ORIGIN, "live", RUNNER);
  await settle();
  const box = root.querySelector<HTMLInputElement>(
    'tr[data-agent="claude"] input[data-runner-extra-usage]',
  )!;
  expect(box).not.toBeNull();
  expect(root.querySelector('tr[data-agent="codex"] button[data-runner-signin]')).not.toBeNull();
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  await settle();
  const post = requests.find((request) => request.init?.method === "POST");
  expect(post?.url).toBe(`/api/runners/${RUNNER}/agents/claude/extra-usage`);
  expect(JSON.parse(String(post!.init!.body))).toEqual({ extraUsage: true });
  expect(new Headers(post!.init!.headers).get("x-paws-csrf")).toBe("token-1");
});

test("Add a runner shows the server's refusal instead of a command", async () => {
  const message = "Too many runner enrollments. Try again shortly.";
  let refused = false;
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    if (new URL(String(url), ORIGIN).pathname !== "/api/runners/enrollments")
      return fallback(url as string, init);
    requests.push({ url: "/api/runners/enrollments", init });
    return refused
      ? Response.json({ error: message }, { status: 409 })
      : Response.json({
          token: "tok_en-123",
          expiresAt: Date.now() + 600_000,
          name: "new-box",
          config: {
            controlPlaneUrl: "https://paws.example.com",
            runnerApiUrl: "https://paws.example.com:8788",
          },
        });
  }) as unknown as typeof fetch;
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as unknown as Parameters<typeof window.document.body.append>[0]);
  createRunners().mount(root, ORIGIN, "live", null);
  await settle();
  root.querySelector<HTMLElement>("[data-runner-add]")!.click();
  await settle();
  const submit = async () => {
    const input = root.querySelector<HTMLInputElement>('input[name="host-name"]')!;
    input.value = "new-box";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    root
      .querySelector("#runner-enrollment")!
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
      );
    await settle();
  };
  await submit();
  expect(root.querySelector("#runner-enroll-command")?.textContent).toContain("tok_en-123");
  const docker = root.querySelector<HTMLInputElement>('input[name="docker-access"]')!;
  expect(docker.checked).toBe(true);
  expect(root.querySelector("#runner-enroll-command")?.textContent).toContain(
    "PAWS_RUNNER_DOCKER_ACCESS=grant",
  );
  docker.checked = false;
  docker.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  expect(root.querySelector("#runner-enroll-command")?.textContent).toContain(
    "PAWS_RUNNER_DOCKER_ACCESS=deny",
  );
  refused = true;
  await submit();
  const dialog = root.querySelector("#runner-add-dialog")!;
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(root.querySelector("#runner-enroll-command")).toBeNull();
  expect(dialog.textContent).not.toContain("tok_en-123");
});

test("with no runners the list explains what a runner is and offers Add a runner", async () => {
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) =>
    new URL(String(url), ORIGIN).pathname === "/api/runners"
      ? Response.json({ runners: [], serverVersion: null })
      : fallback(url as string, init)) as unknown as typeof fetch;
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as unknown as Parameters<typeof window.document.body.append>[0]);
  createRunners().mount(root, ORIGIN, "live", null);
  await settle();
  const empty = root.querySelector('[aria-labelledby="runners-empty-heading"]');
  expect(empty?.textContent).toContain("No runners are enrolled");
  expect(empty?.textContent).toContain("A runner is a Linux machine that runs the coding agents.");
  expect(empty?.querySelectorAll("ol > li")).toHaveLength(3);
  expect(root.querySelectorAll("[data-runner-add]")).toHaveLength(1);
  expect(empty?.querySelector("[data-runner-add]")).not.toBeNull();
  expect(root.querySelector("table")).toBeNull();
});

async function mountWithAgents(role: string) {
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url), ORIGIN).pathname;
    if (path === "/api/auth/session") return Response.json({ userId: "owner", role });
    if (path === "/api/workspaces/repositories") return Response.json({ repositories: [] });
    if (path === "/api/runners/coding-agents/update-all") {
      requests.push({ url: path, init });
      return Response.json({ requested: 1 });
    }
    if (path !== "/api/runners") return fallback(url as string, init);
    return Response.json({
      serverVersion: null,
      agentVersions: [{ agent: "claude", offered: "2.1.0", refused: [], checkedAt: Date.now() }],
      runners: [
        { ...runner, codingAgents: [{ agent: "claude", current: "2.0.0", pending: null }] },
      ],
    });
  }) as unknown as typeof fetch;
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as unknown as Parameters<typeof window.document.body.append>[0]);
  createRunners().mount(root, ORIGIN, "live", null);
  await settle();
  return root;
}

test("Update coding agents opens the versions dialog and Update all runners posts update-all", async () => {
  const root = await mountWithAgents("admin");
  const open = root.querySelector<HTMLElement>("[data-agents-open]")!;
  expect(open.textContent).toBe("Update coding agents 1");
  expect(root.querySelector("#agents-dialog")).toBeNull();
  open.click();
  await settle();
  const dialog = root.querySelector<HTMLDialogElement>("#agents-dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("build-box2.0.0Newest eligible 2.1.0");
  dialog.querySelector<HTMLElement>("[data-agents-update-all]")!.click();
  await settle();
  const post = requests.find((request) => request.init?.method === "POST");
  expect(post?.url).toBe("/api/runners/coding-agents/update-all");
  expect(root.querySelector("#agents-dialog")?.textContent).toContain(
    "Sent 1 coding agent update to your runners.",
  );
  root.querySelector<HTMLElement>("[data-agents-close]")!.click();
  await settle();
  expect(root.querySelector("#agents-dialog")).toBeNull();
});

test("members who do not manage runners see the versions without Update all runners", async () => {
  const root = await mountWithAgents("member");
  root.querySelector<HTMLElement>("[data-agents-open]")!.click();
  await settle();
  const dialog = root.querySelector("#agents-dialog")!;
  expect(dialog.textContent).toContain("Offered 2.1.0");
  expect(dialog.querySelector("[data-agents-update-all]")).toBeNull();
});
