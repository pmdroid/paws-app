import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createOnboardingReadiness } from "../src/onboarding-readiness";
import {
  issueWorkspaceBootstrap,
  onboardingPage,
  onboardingSteps,
  workspaceTokenHash,
  type OnboardingPageInput,
  type OnboardingReadiness,
  type OnboardingVmStep,
} from "../src/workspace";

const NOW = 1_800_000_000_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "paws-onboarding-readiness-"));
  roots.push(root);
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const user = (id: string) => {
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
    return id;
  };
  consumeWorkspaceBootstrap(db, {
    id: "ws",
    organizationId: "org",
    name: "Test",
    userId: user("owner"),
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", NOW)),
    now: NOW,
  });
  for (const id of ["me", "colleague", "lead"])
    syncWorkspaceMember(db, {
      workspaceId: "ws",
      userId: user(id),
      role: "member",
      active: true,
      teamIds: ["team"],
      now: NOW,
    });
  const read = createOnboardingReadiness(db);
  return {
    db,
    read: (projectLeadIds: string[] = []) =>
      read({ workspaceId: "ws", userId: "me", teamId: "team", projectLeadIds, now: NOW }),
  };
}

function runner(
  db: Database,
  id: string,
  input: {
    owner?: string;
    status?: string;
    seenAgoMs?: number;
    sharing?: number;
    agents?: Record<string, { ready: number; authExpired?: number }>;
  } = {},
) {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
    [
      id,
      "ws",
      input.owner ?? "me",
      `${id}-host`,
      input.status ?? "active",
      NOW,
      NOW - (input.seenAgoMs ?? 0),
    ],
  );
  if (input.sharing !== undefined)
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,?)", [id, input.sharing]);
  for (const [agent, policy] of Object.entries(input.agents ?? {}))
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready,auth_expired) VALUES(?,?,?,?)", [
      id,
      agent,
      policy.ready,
      policy.authExpired ?? 0,
    ]);
}

function vm(db: Database, step: string, failure: string | null = null) {
  db.run(
    `INSERT INTO member_vm(id,workspace_id,user_id,vm_name,step,failure,step_started_at,created_at,updated_at)
    VALUES('vm','ws','me','me-paws',?,?,?,?,?)`,
    [step, failure, NOW, NOW, NOW],
  );
}

const WAITING = { claude: "waiting", codex: "waiting" } as const;
const NEEDED: OnboardingReadiness = {
  runner: { state: "needed" },
  agents: WAITING,
  memberVm: false,
};
const VM_STEPS = (states: OnboardingVmStep["state"][]): OnboardingVmStep[] =>
  (["create", "install", "enroll", "health"] as const).map((step, index) => ({
    step,
    state: states[index]!,
  }));

test("a member with no runner needs one, and another member's runner does not count", () => {
  const w = workspace();
  runner(w.db, "theirs", { owner: "colleague", agents: { claude: { ready: 1 } } });
  expect(w.read()).toEqual(NEEDED);
});

test("another member's runner never counts, shared or not, unless they lead the issue's project", () => {
  const w = workspace();
  runner(w.db, "theirs", { owner: "colleague", sharing: 1, agents: { claude: { ready: 1 } } });
  runner(w.db, "private", { owner: "lead", agents: { claude: { ready: 1 } } });
  runner(w.db, "stopped", { owner: "colleague", seenAgoMs: 10 * 60_000 });
  expect(w.read()).toEqual(NEEDED);
  // The lead's own unshared runner stays theirs, and the page says so.
  expect(w.read(["lead"])).toEqual({
    ...NEEDED,
    runner: { state: "needed", reason: "lead's runner isn't shared." },
  });
  // A colleague who does not lead the project lends nothing, even with sharing on.
  expect(w.read(["someone-else"])).toEqual(NEEDED);
});

test("a runner the issue's project lead shares makes the step ready, naming who shares it", () => {
  const w = workspace();
  runner(w.db, "shared", {
    owner: "lead",
    sharing: 1,
    agents: { claude: { ready: 1 }, codex: { ready: 1 } },
  });
  expect(w.read(["lead"])).toEqual({
    runner: { state: "ready", id: "shared", name: "shared-host", sharedBy: "lead" },
    agents: { claude: "connected", codex: "connected" },
    memberVm: false,
  });
  // The member's own runner wins when it is as far along.
  runner(w.db, "mine", { agents: { claude: { ready: 1 }, codex: { ready: 1 } } });
  expect(w.read(["lead"])).toEqual({
    runner: { state: "ready", id: "mine", name: "mine-host" },
    agents: { claude: "connected", codex: "connected" },
    memberVm: false,
  });
});

test("the lead's shared runner that is offline says so", () => {
  const w = workspace();
  runner(w.db, "shared", { owner: "lead", sharing: 1, seenAgoMs: 10 * 60_000 });
  expect(w.read(["lead"])).toEqual({
    ...NEEDED,
    runner: { state: "offline", name: "shared-host", sharedBy: "lead" },
  });
});

test("the step turns ready when the member's runner enrolls, with no restart", () => {
  const w = workspace();
  vm(w.db, "enroll");
  expect(w.read()).toEqual({
    runner: {
      state: "setting-up",
      name: "me-paws",
      steps: VM_STEPS(["done", "done", "running", "pending"]),
    },
    agents: WAITING,
    memberVm: true,
  });
  // The VM's runner enrolls and reports in; the next read shows it.
  runner(w.db, "vm-runner");
  expect(w.read()).toEqual({
    runner: { state: "ready", id: "vm-runner", name: "vm-runner-host" },
    agents: WAITING,
    memberVm: true,
  });
});

test("a VM being set up or failed shows as the runner step, with each setup step", () => {
  const w = workspace();
  vm(w.db, "install");
  expect(w.read()).toEqual({
    runner: {
      state: "setting-up",
      name: "me-paws",
      steps: VM_STEPS(["done", "running", "pending", "pending"]),
    },
    agents: WAITING,
    memberVm: true,
  });
  w.db.run("UPDATE member_vm SET failure='npm ci failed'");
  expect(w.read()).toEqual({
    runner: {
      state: "failed",
      name: "me-paws",
      failure: "npm ci failed",
      steps: VM_STEPS(["done", "failed", "pending", "pending"]),
    },
    agents: WAITING,
    memberVm: true,
  });
});

test("an offline or paused own runner says so", () => {
  const w = workspace();
  runner(w.db, "old", { seenAgoMs: 10 * 60_000 });
  expect(w.read()).toEqual({
    ...NEEDED,
    runner: { state: "offline", id: "old", name: "old-host" },
  });
  w.db.run("UPDATE runner SET status='paused',last_seen_at=?", [NOW]);
  expect(w.read()).toEqual({
    ...NEEDED,
    runner: { state: "paused", id: "old", name: "old-host" },
  });
});

test("a ready runner reports each coding agent's sign-in, preferring the most connected", () => {
  const w = workspace();
  runner(w.db, "a", { agents: { claude: { ready: 1 }, codex: { ready: 0, authExpired: 1 } } });
  expect(w.read()).toEqual({
    runner: { state: "ready", id: "a", name: "a-host" },
    agents: { claude: "connected", codex: "expired" },
    memberVm: false,
  });
  runner(w.db, "b", { agents: { claude: { ready: 1 }, codex: { ready: 1 } } });
  expect(w.read()).toEqual({
    runner: { state: "ready", id: "b", name: "b-host" },
    agents: { claude: "connected", codex: "connected" },
    memberVm: false,
  });
});

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
  csrfToken: "csrf",
};

test("the page lists Linear, membership, runner, coding agents, then the optional GitHub credit", () => {
  expect(onboardingSteps(base).map((step) => [step.title, step.label])).toEqual([
    ["Linear", "Done"],
    ["Membership", "Done"],
    ["Runner", "Needed"],
    ["Claude and Codex", "After the runner"],
    ["GitHub credit", "Optional"],
  ]);
  const ready = onboardingSteps({
    ...base,
    readiness: {
      runner: { state: "ready", id: "R", name: "mia-paws" },
      agents: { claude: "connected", codex: "expired" },
      memberVm: true,
    },
    github: { login: "mia-chen" },
  });
  expect(ready.slice(2).map((step) => [step.label, step.detail])).toEqual([
    ["Ready", "mia-paws will run this task."],
    ["Sign-in expired", "Sign in to Codex on mia-paws. The Codex sign-in expired."],
    ["Linked", "Commits will credit @mia-chen."],
  ]);
});

test("with no usable runner the step offers Create VM and Add a host on the page", async () => {
  const [needed] = onboardingSteps(base).slice(2);
  expect(needed).toMatchObject({
    state: "needed",
    actions: [
      { button: "create-vm", label: "Create VM" },
      { button: "add-host", label: "Add a host" },
    ],
  });
  const [hostOnly] = onboardingSteps({ ...base, createVm: false }).slice(2);
  expect(hostOnly?.actions).toEqual([{ button: "add-host", label: "Add a host" }]);
  const html = await onboardingPage(base).text();
  expect(html).toContain(
    '<button type="button" class="action" data-action="create-vm">Create VM</button>',
  );
  expect(html).toContain('<section class="host" id="host" hidden');
  const observer = onboardingSteps({ ...base, observer: true, memberOfTeam: false });
  expect(observer[1]?.detail).toContain("You are an observer in Paws.");
  expect(observer[2]?.actions).toEqual([]);
});

test("a fully set up member sees no remaining steps and the page stops reloading", async () => {
  const page = onboardingPage({
    ...base,
    readiness: {
      runner: { state: "ready", id: "R", name: "mia-paws" },
      agents: { claude: "connected", codex: "connected" },
      memberVm: true,
    },
  });
  const html = await page.text();
  expect(html).toContain("Welcome, Mia");
  expect(html).toContain("You're set up. Paws runs <strong>TEST-1</strong> on mia-paws.");
  expect(html).not.toContain("http-equiv");
  expect(html).toContain('<main data-poll="">');
});

test("values on the page are escaped", async () => {
  const html = await onboardingPage({
    ...base,
    member: { name: "<script>x</script>", email: null },
    csrfToken: '"><script>',
    readiness: {
      runner: { state: "failed", name: "vm", failure: '<img src=x onerror="y">', steps: [] },
      agents: WAITING,
      memberVm: true,
    },
  }).text();
  expect(html).not.toContain("<script>x");
  expect(html).not.toContain('"><script>');
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=&quot;y&quot;&gt;");
});

test("the optional GitHub step offers a consent form that posts to this page, and never blocks", async () => {
  expect(onboardingSteps(base).at(-1)).toMatchObject({
    state: "optional",
    detail: "Link GitHub to get credit on commits and pull requests (optional).",
  });
  const offered = onboardingPage({
    ...base,
    githubLink: { action: "/onboard/ABCDEFGHJKMNPQRSTVWXYZ0123", csrf: 'tok"en' },
  });
  expect(offered.headers.get("content-security-policy")).toContain(
    "form-action 'self' https://github.com",
  );
  const html = await offered.text();
  expect(html).toContain('<form method="post" action="/onboard/ABCDEFGHJKMNPQRSTVWXYZ0123">');
  expect(html).toContain('<input type="hidden" name="csrf" value="tok&quot;en">');
  expect(html).toContain('name="consent" value="yes" required');
  // Optional steps are not counted, so the page reads the same with or without the link.
  expect(html).toContain("2 more steps before Paws starts");

  for (const input of [
    { ...base, githubLink: null },
    { ...base, github: { login: "mia-chen" }, githubLink: { action: "/onboard/x", csrf: "t" } },
  ]) {
    const page = onboardingPage(input);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'none'");
    // No credit form; the Add a host form never submits, so form-action stays 'none'.
    expect(await page.text()).not.toContain('<form method="post"');
  }
});
