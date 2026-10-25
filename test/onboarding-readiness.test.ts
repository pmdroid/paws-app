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

test("a member with no runner needs one, and another member's runner does not count", () => {
  const w = workspace();
  runner(w.db, "theirs", { owner: "colleague", agents: { claude: { ready: 1 } } });
  expect(w.read()).toEqual({ runner: { state: "needed" }, agents: WAITING });
});

test("another member's runner never counts, shared or not, unless they lead the issue's project", () => {
  const w = workspace();
  runner(w.db, "theirs", { owner: "colleague", sharing: 1, agents: { claude: { ready: 1 } } });
  runner(w.db, "private", { owner: "lead", agents: { claude: { ready: 1 } } });
  runner(w.db, "stopped", { owner: "colleague", seenAgoMs: 10 * 60_000 });
  expect(w.read()).toEqual({ runner: { state: "needed" }, agents: WAITING });
  // The lead's own unshared runner stays theirs.
  expect(w.read(["lead"])).toEqual({ runner: { state: "needed" }, agents: WAITING });
  // A colleague who does not lead the project lends nothing, even with sharing on.
  expect(w.read(["someone-else"])).toEqual({ runner: { state: "needed" }, agents: WAITING });
});

test("a runner the issue's project lead shares makes the step ready, naming who shares it", () => {
  const w = workspace();
  runner(w.db, "shared", {
    owner: "lead",
    sharing: 1,
    agents: { claude: { ready: 1 }, codex: { ready: 1 } },
  });
  expect(w.read(["lead"])).toEqual({
    runner: { state: "ready", name: "shared-host", sharedBy: "lead" },
    agents: { claude: "connected", codex: "connected" },
  });
  // The member's own runner wins when it is as far along.
  runner(w.db, "mine", { agents: { claude: { ready: 1 }, codex: { ready: 1 } } });
  expect(w.read(["lead"])).toEqual({
    runner: { state: "ready", name: "mine-host" },
    agents: { claude: "connected", codex: "connected" },
  });
});

test("the step turns ready when the member's runner enrolls, with no restart", () => {
  const w = workspace();
  vm(w.db, "enroll");
  expect(w.read()).toEqual({ runner: { state: "setting-up", name: "me-paws" }, agents: WAITING });
  // The VM's runner enrolls and reports in; the next read shows it.
  runner(w.db, "vm-runner");
  expect(w.read()).toEqual({ runner: { state: "ready", name: "vm-runner-host" }, agents: WAITING });
});

test("a VM being set up or failed shows as the runner step", () => {
  const w = workspace();
  vm(w.db, "install");
  expect(w.read()).toEqual({ runner: { state: "setting-up", name: "me-paws" }, agents: WAITING });
  w.db.run("UPDATE member_vm SET failure='npm ci failed'");
  expect(w.read()).toEqual({
    runner: { state: "failed", name: "me-paws", failure: "npm ci failed" },
    agents: WAITING,
  });
});

test("an offline or paused own runner says so", () => {
  const w = workspace();
  runner(w.db, "old", { seenAgoMs: 10 * 60_000 });
  expect(w.read()).toEqual({ runner: { state: "offline", name: "old-host" }, agents: WAITING });
  w.db.run("UPDATE runner SET status='paused',last_seen_at=?", [NOW]);
  expect(w.read()).toEqual({ runner: { state: "paused", name: "old-host" }, agents: WAITING });
});

test("a ready runner reports each coding agent's sign-in, preferring the most connected", () => {
  const w = workspace();
  runner(w.db, "a", { agents: { claude: { ready: 1 }, codex: { ready: 0, authExpired: 1 } } });
  expect(w.read()).toEqual({
    runner: { state: "ready", name: "a-host" },
    agents: { claude: "connected", codex: "expired" },
  });
  runner(w.db, "b", { agents: { claude: { ready: 1 }, codex: { ready: 1 } } });
  expect(w.read()).toEqual({
    runner: { state: "ready", name: "b-host" },
    agents: { claude: "connected", codex: "connected" },
  });
});

const base: OnboardingPageInput = {
  identifier: "TEST-1",
  issueUrl: null,
  teamName: "Platform",
  member: { name: "Mia Chen", email: "mia@example.invalid" },
  memberOfTeam: true,
  readiness: { runner: { state: "needed" }, agents: { claude: "waiting", codex: "waiting" } },
  github: null,
  createVm: true,
};

test("the page lists Linear, membership, runner, coding agents, then the optional GitHub credit", () => {
  expect(onboardingSteps(base).map((step) => [step.title, step.label])).toEqual([
    ["Linear", "Done"],
    ["Membership", "Done"],
    ["Your runner", "Needed"],
    ["Claude and Codex", "After the runner"],
    ["GitHub credit", "Optional"],
  ]);
  const ready = onboardingSteps({
    ...base,
    readiness: {
      runner: { state: "ready", name: "mia-paws" },
      agents: { claude: "connected", codex: "expired" },
    },
    github: { login: "mia-chen" },
  });
  expect(ready.slice(2).map((step) => [step.label, step.detail])).toEqual([
    ["Ready", "Paws runs TEST-1 on mia-paws."],
    ["Sign-in expired", "Sign in to Codex on mia-paws. The Codex sign-in expired."],
    ["Linked", "Linked as @mia-chen. Your commits credit you."],
  ]);
});

test("with no usable runner the page offers Create VM or Add a host on the Runners page", async () => {
  const [needed] = onboardingSteps(base).slice(2);
  expect(needed).toMatchObject({
    state: "needed",
    detail:
      "Paws runs your issues on a runner you own. Create a VM, or add a host with an enrollment token. This step completes when it is ready.",
    action: { href: "/status/runners", label: "Create VM or add a host" },
  });
  const [hostOnly] = onboardingSteps({ ...base, createVm: false }).slice(2);
  expect(hostOnly).toMatchObject({
    detail:
      "Paws runs your issues on a runner you own. Add a host with an enrollment token. This step completes when it pairs.",
    action: { href: "/status/runners", label: "Add a host" },
  });
  const html = await onboardingPage(base).text();
  expect(html).toContain('<a class="action" href="/status/runners">Create VM or add a host</a>');
  const shared = onboardingSteps({
    ...base,
    readiness: {
      runner: { state: "ready", name: "lead-box", sharedBy: "Ada" },
      agents: { claude: "waiting", codex: "waiting" },
    },
  })[2];
  expect(shared).toMatchObject({
    label: "Ready",
    detail: "Paws runs TEST-1 on lead-box, shared by Ada.",
  });
  expect(shared?.action).toBeUndefined();
});

test("a fully set up member sees no remaining steps and the page stops reloading", async () => {
  const page = onboardingPage({
    ...base,
    readiness: {
      runner: { state: "ready", name: "mia-paws" },
      agents: { claude: "connected", codex: "connected" },
    },
  });
  const html = await page.text();
  expect(html).toContain("Welcome, Mia");
  expect(html).toContain("You're set up. Paws runs <strong>TEST-1</strong> on your runner.");
  expect(html).not.toContain("http-equiv");
});

test("values on the page are escaped", async () => {
  const html = await onboardingPage({
    ...base,
    member: { name: "<script>x</script>", email: null },
    readiness: {
      runner: { state: "failed", name: "vm", failure: '<img src=x onerror="y">' },
      agents: { claude: "waiting", codex: "waiting" },
    },
  }).text();
  expect(html).not.toContain("<script>x");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=&quot;y&quot;&gt;");
});
