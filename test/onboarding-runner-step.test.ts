import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { FakeClock } from "../src/core";
import {
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  ensureLinearSession,
  insertQueuedItem,
  JobLoop,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import {
  createMemberVmHttp,
  findMemberVm,
  MEMBER_VM_POLL_MS,
  registerMemberVmJob,
  type MemberVm,
} from "../src/member-vm";
import { createOnboardingReadiness } from "../src/onboarding-readiness";
import { createFakeBootstrap, createFakeExeDev } from "../src/provisioning";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { itemOwnerHasEligibleRunner } from "../src/runner-placement";
import {
  issueWorkspaceBootstrap,
  onboardingPage,
  workspaceId,
  workspaceTokenHash,
  type OnboardingPageInput,
  type OnboardingReadiness,
  type WorkspacePrincipal,
} from "../src/workspace";

const ORIGIN = "https://paws.test";
const CSRF = "csrf-token";
const HOST_CONFIG = {
  controlPlaneUrl: "https://paws.test",
  runnerApiUrl: "https://paws.test:8443",
  allowedRepositories: ["acme/app"],
};
const roots: string[] = [];
const windows: Window[] = [];

afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Lets the page script's awaited requests finish. */
async function settle() {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Loads `html` into a DOM and runs its inline script with `fetch` and fake timers, as a browser
 * would. Returns the document and a way to fire the page's next poll.
 */
function load(html: string, fetch: (input: string, init?: RequestInit) => Promise<Response>) {
  const window = new Window({ url: `${ORIGIN}/onboard/link` });
  windows.push(window);
  window.document.write(html);
  const timers = new Map<number, () => unknown>();
  let next = 0;
  const script = window.document.querySelector("script")?.textContent ?? "";
  new Function(
    "document",
    "location",
    "fetch",
    "DOMParser",
    "setTimeout",
    "clearTimeout",
    "navigator",
    script,
  )(
    window.document,
    window.location,
    fetch,
    window.DOMParser,
    (handler: () => unknown) => {
      timers.set(++next, handler);
      return next;
    },
    (id: number) => timers.delete(id),
    window.navigator,
  );
  const document = window.document;
  return {
    document,
    pending: () => timers.size,
    async poll() {
      const due = [...timers.values()];
      timers.clear();
      for (const handler of due) await handler();
      await settle();
    },
    runner: () => document.querySelector("#steps [data-runner]"),
    detail: () => document.querySelector("#steps [data-runner] .detail")?.textContent,
    buttons: () =>
      [...document.querySelectorAll("button[data-action]")].map((button) =>
        button.getAttribute("data-action"),
      ),
    async click(action: string) {
      const button = document.querySelector(`button[data-action="${action}"]`);
      if (!button) throw new Error(`No ${action} button`);
      (button as unknown as { click(): void }).click();
      await settle();
    },
  };
}

async function fixture({
  role = "member",
  available = true,
}: { role?: "member" | "observer"; available?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-onboarding-runner-"));
  roots.push(root);
  const clock = new FakeClock(Date.UTC(2026, 9, 25));
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const ownerId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Workspace Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "org",
    userId: ownerId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", clock.now())),
    now: clock.now(),
  });
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "ada",
    name: "Ada Lovelace",
    email: "ada@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId,
    role,
    active: true,
    teamIds: ["team"],
    now: clock.now(),
  });
  const member: WorkspacePrincipal = {
    workspaceId: workspace.id,
    userId,
    role,
    authenticatedAt: clock.now(),
    teamIds: ["team"],
  };
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: () => {},
    now: () => clock.now(),
  });
  const runnerHttp = createRunnerHttp(control, { hostConfig: () => HOST_CONFIG });
  const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
  registerMemberVmJob(loop, {
    exeDev: createFakeExeDev(),
    bootstrap: createFakeBootstrap({
      installPolls: 1,
      async enroll(vm, token) {
        const key = await createRunnerKey(join(root, `host-${vm}`));
        const identity = await control.enroll({ token, name: vm, csr: key.csr });
        return { runnerId: identity.runnerId, workspaceId: identity.workspaceId };
      },
    }),
    mintEnrollment: (_ref, request) => control.createEnrollment(member, request),
    now: () => clock.now(),
  });
  const vmHttp = createMemberVmHttp({ db, available: () => available, now: () => clock.now() });
  const read = createOnboardingReadiness(db);
  const page = () =>
    onboardingPage({
      identifier: "TEST-1",
      issueUrl: null,
      teamName: "Platform",
      member: { name: "Ada Lovelace", email: "ada@example.invalid" },
      memberOfTeam: role !== "observer",
      observer: role === "observer",
      readiness: read({
        workspaceId: workspace.id,
        userId,
        teamId: "team",
        projectLeadIds: [],
        now: clock.now(),
      }),
      github: null,
      createVm: available,
      csrfToken: CSRF,
    });
  const requests: string[] = [];
  /** The page's origin: the onboarding page itself, and the existing runner routes behind CSRF. */
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, ORIGIN);
    const method = init.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/onboard/link" && method === "GET") return page();
    const headers = new Headers(init.headers);
    if (method !== "GET" && headers.get("x-paws-csrf") !== CSRF)
      return Response.json({ error: "CSRF" }, { status: 403 });
    const request = new Request(url.href, { method, headers, body: init.body ?? null });
    return (
      (await vmHttp(request, member)) ??
      (await runnerHttp.browser(request, member)) ??
      new Response(null, { status: 404 })
    );
  };
  const open = async () => load(await page().text(), fetch);
  /** Runs the member VM job until `until` holds, as the job loop would in the background. */
  const drive = async (until: (row: MemberVm) => boolean) => {
    for (let index = 0; index < 500; index++) {
      const row = findMemberVm(db, member)!;
      if (until(row)) return row;
      if ((await loop.tick()) === null) clock.advance(MEMBER_VM_POLL_MS);
    }
    throw new Error("member VM did not settle");
  };
  /** A queued item Ada delegated, which the scheduler starts once she has an eligible runner. */
  const heldItem = () => {
    const item = insertQueuedItem(db, { id: "held", now: clock.now(), sessionKey: "session" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id='held'", [userId]);
    ensureLinearSession(db, {
      sessionId: "session",
      issueId: item.linearIssueId,
      organizationId: "org",
      creatorId: "ada",
      now: clock.now(),
    });
    recordLinearInstallation(db, {
      sessionId: "session",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: clock.now(),
    });
    bindLinearSessionTask(db, "session", item.delegationId);
    return () =>
      itemOwnerHasEligibleRunner(db, { itemId: "held", agent: "claude", now: clock.now() });
  };
  return { db, clock, control, member, fetch, open, page, drive, heldItem, requests };
}

const WAITING = { claude: "waiting", codex: "waiting" } as const;
const base: OnboardingPageInput = {
  identifier: "TEST-1",
  issueUrl: null,
  teamName: "Platform",
  member: { name: "Mia Chen", email: "mia@example.invalid" },
  memberOfTeam: true,
  observer: false,
  readiness: { runner: { state: "needed" }, agents: WAITING, memberVm: false },
  github: null,
  createVm: true,
  csrfToken: CSRF,
};
const render = async (input: Partial<OnboardingPageInput>, readiness?: OnboardingReadiness) => {
  const page = { ...base, ...input, ...(readiness ? { readiness } : {}) };
  return load(await onboardingPage(page).text(), async () => new Response(null, { status: 404 }));
};

test("the member's own runner, a lead's shared runner, and none render the runner step", async () => {
  const own = await render(
    {},
    {
      runner: { state: "ready", id: "R1", name: "mia-box" },
      agents: { claude: "connected", codex: "connected" },
      memberVm: false,
    },
  );
  expect(own.detail()).toBe("mia-box will run this task.");
  expect(own.document.querySelector("#lead")?.textContent).toBe(
    "You're set up. Paws runs TEST-1 on mia-box.",
  );
  expect(own.buttons()).toEqual([]);

  const shared = await render(
    {},
    {
      runner: { state: "ready", id: "R2", name: "lead-box", sharedBy: "Lena Lead" },
      agents: { claude: "connected", codex: "connected" },
      memberVm: false,
    },
  );
  expect(shared.detail()).toBe("Lena Lead's shared runner lead-box will run this task.");

  const none = await render({});
  expect(none.detail()).toBe(
    "You have no runner Paws can use for this task. Create a VM, or add a host with an enrollment token. This step completes when the runner is ready.",
  );
  expect(none.buttons()).toEqual(["create-vm", "add-host"]);

  const unshared = await render(
    { createVm: false },
    {
      runner: { state: "needed", reason: "Lena Lead's runner isn't shared." },
      agents: WAITING,
      memberVm: false,
    },
  );
  expect(unshared.detail()).toBe(
    "Lena Lead's runner isn't shared. Add a host with an enrollment token. This step completes when it pairs.",
  );
  // Create VM is shown only when exe.dev is available.
  expect(unshared.buttons()).toEqual(["add-host"]);

  const offline = await render(
    {},
    {
      runner: { state: "offline", name: "lead-box", sharedBy: "Lena Lead" },
      agents: WAITING,
      memberVm: false,
    },
  );
  expect(offline.detail()).toBe(
    "Lena Lead's shared runner lead-box is offline. Ask Lena Lead to start it, or set up a runner of your own.",
  );
  expect(offline.buttons()).toEqual(["create-vm", "add-host"]);

  const mineOffline = await render(
    {},
    {
      runner: { state: "offline", name: "mia-box" },
      agents: WAITING,
      memberVm: true,
    },
  );
  expect(mineOffline.detail()).toBe(
    "mia-box is offline. Start it so Paws can use it, or set up a runner of your own.",
  );
  // A member who already has a VM is not offered a second one.
  expect(mineOffline.buttons()).toEqual(["add-host"]);
});

test("a missing agent sign-in links to the sign-in on the member's own runner", async () => {
  const own = await render(
    {},
    {
      runner: { state: "ready", id: "01RUNNER", name: "mia-box" },
      agents: { claude: "connected", codex: "expired" },
      memberVm: false,
    },
  );
  const agents = own.document.querySelectorAll("#steps > li")[3]!;
  expect(agents.querySelector(".detail")?.textContent).toBe(
    "Sign in to Codex on mia-box. The Codex sign-in expired.",
  );
  const link = agents.querySelector("a.action");
  expect(link?.getAttribute("href")).toBe("/status/runners/01RUNNER");
  expect(link?.textContent).toBe("Sign in on mia-box");
  // Only the owner can sign in on a shared runner, so the page names them instead of linking.
  const shared = await render(
    {},
    {
      runner: { state: "ready", id: "R2", name: "lead-box", sharedBy: "Lena Lead" },
      agents: { claude: "waiting", codex: "connected" },
      memberVm: false,
    },
  );
  const sharedAgents = shared.document.querySelectorAll("#steps > li")[3]!;
  expect(sharedAgents.querySelector(".detail")?.textContent).toBe(
    "Ask Lena Lead to sign in to Claude on lead-box.",
  );
  expect(sharedAgents.querySelector("a")).toBeNull();
});

test("Create VM creates the member's VM, its steps update without a reload, and readiness lets the held item start", async () => {
  const f = await fixture();
  const ready = f.heldItem();
  expect(ready()).toBe(false);
  const page = await f.open();
  expect(page.buttons()).toEqual(["create-vm", "add-host"]);
  await page.click("create-vm");
  expect(f.requests).toContain("POST /api/runners/vm");
  expect(findMemberVm(f.db, f.member)?.step).toBe("create");
  // The same document now shows the VM's steps; the page polls faster while it sets up.
  expect(page.runner()?.getAttribute("data-runner")).toBe("setting-up");
  const states = () =>
    [...page.document.querySelectorAll("[data-vm-step]")].map(
      (row) => `${row.getAttribute("data-vm-step")}:${row.getAttribute("data-vm-state")}`,
    );
  expect(states()).toEqual([
    "create:running",
    "install:pending",
    "enroll:pending",
    "health:pending",
  ]);
  expect(page.document.querySelector("main")?.getAttribute("data-poll")).toBe("3000");
  expect(page.buttons()).toEqual([]);

  await f.drive((row) => row.step === "enroll");
  await page.poll();
  expect(states()).toEqual(["create:done", "install:done", "enroll:running", "health:pending"]);

  const health = await f.drive((row) => row.step === "health" && row.runnerId !== null);
  await page.poll();
  expect(states()).toEqual(["create:done", "install:done", "enroll:done", "health:running"]);
  // The VM's runner sends its first heartbeat, and the job marks the VM ready.
  f.db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [f.clock.now(), health.runnerId]);
  const vm = await f.drive((row) => row.step === "ready");
  f.db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [f.clock.now(), vm.runnerId]);
  await page.poll();
  const name = f.db
    .query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?")
    .get(vm.runnerId!)!.name;
  expect(page.detail()).toBe(`${name} will run this task.`);
  expect(page.document.querySelector(`a[href="/status/runners/${vm.runnerId}"]`)).not.toBeNull();
  // Readiness is the scheduler's gate for a held first delegation: once the agents sign in on
  // the new runner, the held item may start.
  expect(ready()).toBe(false);
  for (const agent of ["claude", "codex"])
    f.db.run(
      "INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1) ON CONFLICT(runner_id,agent) DO UPDATE SET ready=1",
      [vm.runnerId, agent],
    );
  expect(ready()).toBe(true);
  await page.poll();
  expect(page.document.querySelector("#lead")?.textContent).toBe(
    `You're set up. Paws runs TEST-1 on ${name}.`,
  );
  expect(page.pending()).toBe(0);
  // Only the page and the existing VM route were requested.
  expect(new Set(f.requests)).toEqual(new Set(["POST /api/runners/vm", "GET /onboard/link"]));
});

test("a failed VM step shows its error and Retry resumes from it", async () => {
  const f = await fixture();
  await f.fetch("/api/runners/vm", { method: "POST", headers: { "x-paws-csrf": CSRF } });
  f.db.run("UPDATE member_vm SET failure='npm ci failed'");
  const page = await f.open();
  expect(page.runner()?.getAttribute("data-runner")).toBe("failed");
  expect(page.detail()).toContain("npm ci failed");
  expect(page.buttons()).toEqual(["retry-vm"]);
  await page.click("retry-vm");
  expect(f.requests).toContain("POST /api/runners/vm/retry");
  expect(findMemberVm(f.db, f.member)?.failure).toBeNull();
  expect(page.runner()?.getAttribute("data-runner")).toBe("setting-up");
});

test("Add a host shows the one command with a single-use token that a reload never shows again", async () => {
  const f = await fixture();
  const page = await f.open();
  const host = page.document.querySelector("#host")!;
  expect(host.hasAttribute("hidden")).toBe(true);
  await page.click("add-host");
  expect(host.hasAttribute("hidden")).toBe(false);
  const form = page.document.querySelector("#host-form")!;
  expect(form.querySelector("input")?.getAttribute("value")).toBe("ada-host");
  form.dispatchEvent(new page.document.defaultView!.Event("submit", { cancelable: true }));
  await settle();
  expect(f.requests).toContain("POST /api/runners/enrollments");
  const shown = page.document.querySelector("#host-command-text")?.textContent ?? "";
  const token = /printf '%s\\n' '([^']+)' \| sudo install -o root -g root/.exec(shown)?.[1];
  expect(token).toBeDefined();
  // The same command the Runners page shows (`hostEnrollmentCommand` in the dashboard).
  const config = JSON.stringify({ ...HOST_CONFIG, concurrency: 2 });
  expect(shown).toBe(
    [
      "curl -fsSL https://get.paws.boo | sudo sh",
      `printf '%s\\n' '${token}' | sudo install -o root -g root -m 0600 /dev/stdin /etc/paws-runner/enrollment-token`,
      `printf '%s\\n' '${config}' | sudo install -o root -g paws-runner -m 0640 /dev/stdin /etc/paws-runner/config.json`,
      "sudo /opt/paws-runner/bin/paws-runner runner enroll --config /etc/paws-runner/config.json --name 'ada-host' --token-file /etc/paws-runner/enrollment-token",
      "sudo rm -f /etc/paws-runner/enrollment-token",
      "sudo systemctl enable --now paws-runner.service",
    ].join(" && \\\n  "),
  );
  expect(page.document.querySelector("#host-command")?.textContent).toContain("works once");

  // A poll swaps the steps but keeps the command on screen.
  await page.poll();
  expect(page.document.querySelector("#host-command-text")?.textContent).toBe(shown);

  // Reloading shows the form again, never the token.
  const reloaded = await f.page().text();
  expect(reloaded).not.toContain(token!);
  const again = await f.open();
  expect(again.document.querySelector("#host-command-text")).toBeNull();

  // The token enrolls one host, once.
  const key = await createRunnerKey(join(roots[0]!, "host-a"));
  const enrolled = await f.control.enroll({ token: token!, name: "ada-host", csr: key.csr });
  // Its first heartbeat.
  f.db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [f.clock.now(), enrolled.runnerId]);
  const other = await createRunnerKey(join(roots[0]!, "host-b"));
  expect(f.control.enroll({ token: token!, name: "ada-host", csr: other.csr })).rejects.toThrow();
  await page.poll();
  expect(page.detail()).toBe("ada-host will run this task.");
  expect(host.hasAttribute("hidden")).toBe(true);
});

test("observers see no Create VM or Add a host, and the routes refuse them", async () => {
  const f = await fixture({ role: "observer" });
  const page = await f.open();
  expect(page.buttons()).toEqual([]);
  expect(page.document.querySelector("#host")).toBeNull();
  expect(page.detail()).toBe(
    "You have no runner Paws can use for this task. Observers cannot own a runner. Ask a workspace member to delegate this issue.",
  );
  for (const [path, body] of [
    ["/api/runners/vm", "{}"],
    ["/api/runners/enrollments", JSON.stringify({ name: "watcher-host" })],
  ] as const) {
    const response = await f.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paws-csrf": CSRF },
      body,
    });
    expect(response.status).toBe(403);
  }
  expect(findMemberVm(f.db, f.member)).toBeNull();
});

test("the page's inline script and style are the only ones its policy allows", async () => {
  const response = onboardingPage(base);
  const policy = response.headers.get("content-security-policy")!;
  const html = await response.text();
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
  const hash = new Bun.CryptoHasher("sha256").update(script).digest("base64");
  expect(policy).toContain(`script-src 'sha256-${hash}'`);
  expect(policy).toContain("connect-src 'self'");
  expect(policy).not.toContain("unsafe-inline");
  expect(html).toContain(`<meta name="paws-csrf" content="${CSRF}">`);
  // Without the script, the page still refreshes itself.
  expect(html).toContain('<noscript><meta http-equiv="refresh" content="15"></noscript>');
});

test("a poll updates the runner step but keeps a GitHub consent the member is filling in", async () => {
  const githubLink = { action: "/onboard/link/github", csrf: CSRF };
  let readiness: OnboardingReadiness = base.readiness;
  const page = load(await onboardingPage({ ...base, githubLink }).text(), async () =>
    onboardingPage({ ...base, githubLink, readiness }),
  );
  const consent = () =>
    page.document.querySelector('input[name="consent"]') as unknown as { checked: boolean };
  consent().checked = true;
  readiness = {
    runner: { state: "ready", id: "R1", name: "mia-box" },
    agents: WAITING,
    memberVm: false,
  };
  await page.poll();
  expect(page.detail()).toBe("mia-box will run this task.");
  expect(consent().checked).toBe(true);
});
