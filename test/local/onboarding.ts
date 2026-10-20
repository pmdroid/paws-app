import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { systemClock } from "../../src/core";
import { createRunnerControl } from "../../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../../src/runner-identity";
import { createRunnerLogin } from "../../src/runner-login";
import { createRunnerWork } from "../../src/runner-work";
import { join, resolve } from "node:path";
import {
  consumeWorkspaceBootstrap,
  ensureLinearSession,
  getRunner,
  JobLoop,
  memberGitHubRecord,
  readMemberVm,
  refreshRepositoryCatalog,
  replaceWorkspaceRepositories,
  workspaceMember,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../../src/db";
import { createFakeTracker } from "../../src/linear";
import { createMemberVmProvisioner } from "../../src/member-vm";
import {
  createFakeExeDev,
  guestRepositoryList,
  type MemberVmBootstrap,
} from "../../src/provisioning";
import {
  createOnboardingPreparation,
  createWorkspaceAccess,
  createWorkspaceAssignments,
  issueWorkspaceBootstrap,
  workspaceTokenHash,
} from "../../src/workspace";
import { handleStatusRequest } from "../../src/web";

const root = resolve(process.argv[2]!);
mkdirSync(root, { recursive: true, mode: 0o700 });
if (
  !realpathSync(process.env.HOME!).startsWith(root + "/") ||
  !realpathSync(process.env.KYOTOAGENT_ROOT!).startsWith(root + "/")
)
  throw new Error("Use a disposable HOME and KYOTOAGENT_ROOT inside the proof directory.");
const db = openDatabase(join(root, "paws.sqlite"));
migrate(db);
const now = Date.now();
const ownerId = putWorkspaceUser(db, {
  id: "owner",
  linearUserId: "owner",
  name: "Owner",
  email: "owner@example.invalid",
});
consumeWorkspaceBootstrap(db, {
  id: "workspace",
  organizationId: "org",
  name: "Fixture",
  tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
  userId: ownerId,
  now,
});
const held = [
  { sessionId: "session", issueId: "issue", identifier: "PAS-339", token: "a".repeat(43) },
  { sessionId: "returning", issueId: "issue-2", identifier: "PAS-340", token: "b".repeat(43) },
].map(({ sessionId, issueId, identifier, token }) => {
  const spec = {
    linearIssueId: issueId,
    identifier,
    title: "Continue setting up your delegated issue",
    description: "Fixture",
    subIssues: [],
  };
  const installation = {
    sessionId,
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now,
  };
  ensureLinearSession(db, { sessionId, issueId, creatorId: "member" });
  recordLinearInstallation(db, installation);
  db.run("INSERT INTO workspace_assignment VALUES(?,?,?,?,?,?,?,?,?)", [
    sessionId,
    0,
    "workspace",
    "member",
    workspaceTokenHash(token),
    JSON.stringify({ installation, spec }),
    "{}",
    now + 600000,
    "pending",
  ]);
  return {
    spec,
    assignment: `/auth/linear?assignment=${token}`,
    page: `/status/onboarding/${sessionId}/0`,
  };
});
const exeDev = createFakeExeDev();
const creating = Promise.withResolvers<void>();
const createVm = exeDev.createVm;
exeDev.createVm = async (input) => {
  await createVm(input);
  await creating.promise;
  return { ...exeDev.vms.get(input.name)! };
};
const authorityRoot = join(root, "issuer");
const control = createRunnerControl({
  db,
  authority: await initializeRunnerAuthority(authorityRoot),
  certificateRoot: authorityRoot,
  disconnect() {},
});
const guest = {
  calls: [] as { operation: string; vm: string }[],
  installAnswer: null as "succeeded" | "failed" | null,
  pairReleased: false,
  healthy: false,
  pairings: new Map<string, Awaited<ReturnType<typeof control.beginPairing>>>(),
  runners: new Map<string, string>(),
  started: new Set<string>(),
  repositories: [] as { vm: string; repositories: string[]; revision: number; fence: number }[],
  policyCalls: [] as {
    vm: string;
    repositories: string[];
    revision: number;
    fence: number;
    accepted: boolean;
  }[],
  policies: new Map<string, { repositories: string[]; revision: number; fence: number }>(),
};
const bootstrap: MemberVmBootstrap = {
  async startInstall(vmName: string) {
    guest.calls.push({ operation: "install", vm: vmName });
  },
  async installStatus(vmName: string) {
    guest.calls.push({ operation: "install-status", vm: vmName });
    const answer = guest.installAnswer ?? "running";
    guest.installAnswer = null;
    return answer;
  },
  async requestPairing(vmName: string) {
    guest.calls.push({ operation: "pair-request", vm: vmName });
    const key = await createRunnerKey(join(root, "guest-keys", `${guest.calls.length}`));
    const pending = await control.beginPairing({ name: vmName, csr: key.csr });
    guest.pairings.set(vmName, pending);
    return {
      code: pending.code,
      requestFingerprint: pending.requestFingerprint,
      expiresAt: pending.expiresAt,
    };
  },
  async completePairing(vmName: string) {
    guest.calls.push({ operation: "pair-complete", vm: vmName });
    const known = guest.runners.get(vmName);
    if (known) return { phase: "paired", runnerId: known };
    const pending = guest.pairings.get(vmName);
    if (!guest.pairReleased || !pending) return { phase: "pending" };
    const claimed = control.claimPairing(pending.id, pending.claim);
    if (claimed.status !== "approved") return { phase: "pending" };
    guest.runners.set(vmName, claimed.runnerId);
    return { phase: "paired", runnerId: claimed.runnerId };
  },
  async startRunner(vmName: string) {
    guest.calls.push({ operation: "runner-start", vm: vmName });
    guest.started.add(vmName);
  },
  async allowRepositories(vmName, repositories, policy) {
    guest.calls.push({ operation: "allow-repositories", vm: vmName });
    const next = { repositories: guestRepositoryList(repositories), ...policy };
    const call = { vm: vmName, ...next, accepted: false };
    guest.policyCalls.push(call);
    if (
      !Number.isSafeInteger(policy.revision) ||
      policy.revision < 0 ||
      !Number.isSafeInteger(policy.fence) ||
      policy.fence < 1 ||
      Buffer.byteLength(JSON.stringify(next)) > 65536
    )
      throw new Error("Repository policy revision is invalid.");
    const previous = guest.policies.get(vmName) ?? { repositories: [], revision: 0, fence: 0 };
    if (next.fence < previous.fence || next.revision < previous.revision)
      throw new Error("Stale repository policy.");
    if (
      next.fence === previous.fence &&
      (next.revision !== previous.revision ||
        JSON.stringify(next.repositories) !== JSON.stringify(previous.repositories))
    )
      throw new Error("Conflicting repository policy.");
    guest.policies.set(vmName, next);
    guest.repositories.push({ vm: vmName, ...next });
    call.accepted = true;
  },
};
const simulatedHealth = "simulated: direct SQL runner.last_seen_at refresh, not mTLS";
function heartbeat(at: number) {
  for (const [vm, runnerId] of guest.runners)
    if (guest.started.has(vm))
      db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [at, runnerId]);
}
const beating = setInterval(() => {
  if (guest.healthy) heartbeat(Date.now());
}, 1000);
const memberships = {
  async installation() {
    return { id: "org", name: "Fixture" };
  },
  async member(organizationId: string, userId: string) {
    return { organizationId, userId, active: true, guest: false, admin: false, teamIds: ["team"] };
  },
};
const configured = "https://paws.example.invalid";
const assignments = createWorkspaceAssignments({
  onboarding: {
    async refresh(assignment) {
      provisioner.ensure(assignment);
    },
    provisioningAvailable: () => true,
  },
  db,
  origin: configured,
  clientId: "client",
  memberships,
  tracker: createFakeTracker(held.map((entry) => entry.spec)),
  lifecycle: {
    async inspect() {
      throw new Error("No execution");
    },
    async startCodeIssue() {
      throw new Error("No execution");
    },
  },
  async accept() {
    return false;
  },
  async continue() {
    throw new Error("No execution");
  },
});
const preparation = createOnboardingPreparation({
  db,
  clientId: "client",
  repositories: createFakeTracker(held.map((entry) => entry.spec)),
});
const provisioner = createMemberVmProvisioner({
  db,
  exeDev,
  bootstrap,
  resources: { cpu: 2, memoryGB: 4 },
  assignments,
  approve: control.approvePairing,
  pollMs: 250,
});
const jobs = new JobLoop(db, systemClock, {
  workerId: "onboarding-fixture",
  pollMs: 100,
  concurrency: 2,
});
assignments.register(jobs);
provisioner.register(jobs);
const halt = new AbortController();
const looping = jobs.run(halt.signal);
const login = createRunnerLogin({
  db,
  work: createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  }),
});
const health = new Set<string>();
const access = createWorkspaceAccess({
  onboardingAgents: () => ({
    login,
    health: {
      agents: (_principal, runnerId) =>
        (["claude", "codex"] as const).map((agent) => ({
          agent,
          status: health.has(`${runnerId}/${agent}`)
            ? ("signed_in" as const)
            : ("unknown" as const),
          checkedAt: Date.now(),
        })),
    },
  }),
  db,
  assignments,
  onboardingVmProvisioning: provisioner.provisioning,
  memberGitHub: {
    secretsDir: join(root, "secrets"),
    client: { clientId: "fixture-github", clientSecret: "fixture-secret" },
  },
  publicUrl: configured,
  clientId: "client",
  installedOrganization: { id: "org", name: "Fixture" },
  memberships,
  fetch: (async (input, init) => {
    if (String(input) === "https://github.com/login/oauth/access_token")
      return Response.json({ access_token: "ghu_fixture", scope: "", token_type: "bearer" });
    if (String(input) === "https://api.github.com/user")
      return Response.json({ id: 123, login: "fixture-member", type: "User" });
    if (String(input).endsWith("/oauth/token"))
      return Response.json({
        access_token: `fixture-${new URLSearchParams(String(init?.body)).get("code")}`,
      });
    if (String(input) !== "https://api.linear.app/graphql") throw new Error("Unexpected provider");
    const id = new Headers(init?.headers).get("authorization")!.replace("Bearer fixture-", "");
    return Response.json({
      data: {
        viewer: {
          id,
          name: id,
          email: `${id}@example.invalid`,
          app: false,
          organization: { id: "org", name: "Fixture" },
        },
      },
    });
  }) as typeof fetch,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__exe-fixture" && request.method === "GET")
      return Response.json({
        creates: exeDev.calls.filter((call) => call.operation === "create").length,
        vms: [...exeDev.vms.keys()],
        installs: guest.calls.filter((call) => call.operation === "install").length,
        pairRequests: guest.calls.filter((call) => call.operation === "pair-request").length,
        runnerStarts: guest.calls.filter((call) => call.operation === "runner-start").length,
        repositoryPolicies: guest.repositories,
        repositoryPolicyCalls: guest.policyCalls,
        policyJobs: db
          .query("SELECT status,recurring_every_ms FROM job WHERE queue='member.vm.provision'")
          .all(),
        guestVms: [...new Set(guest.calls.map((call) => call.vm))],
      });
    if (url.pathname === "/__exe-fixture" && request.method === "POST") {
      const mode = url.searchParams.get("mode");
      if (mode !== "created" && mode !== "running")
        return Response.json({ error: "Unknown provider mode." }, { status: 400 });
      if (mode === "running") for (const vm of exeDev.vms.values()) vm.status = "running";
      creating.resolve();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__policy-fixture" && request.method === "POST") {
      const input = (await request.json()) as {
        vm: string;
        repositories: string[];
        revision: number;
        fence: number;
      };
      if (!guest.policies.has(input.vm))
        return Response.json({ error: "No published guest policy." }, { status: 409 });
      try {
        await bootstrap.allowRepositories(input.vm, input.repositories, {
          revision: input.revision,
          fence: input.fence,
        });
        return Response.json({ accepted: true });
      } catch (error) {
        return Response.json({ accepted: false, error: (error as Error).message });
      }
    }
    if (url.pathname === "/__provisioning-fixture" && request.method === "POST") {
      const step = url.searchParams.get("step");
      if (step === "install-ok") guest.installAnswer = "succeeded";
      else if (step === "install-fail") guest.installAnswer = "failed";
      else if (step === "pair") guest.pairReleased = true;
      else if (step === "health" || step === "health-fail") {
        guest.healthy = step === "health";
        heartbeat(guest.healthy ? Date.now() : 0);
      } else if (step === "repository") {
        const [vm, runnerId] = [...guest.runners][0] ?? [];
        const runner = runnerId ? getRunner(db, runnerId) : null;
        if (!vm || !runner?.ownerUserId)
          return Response.json({ error: "No paired runner." }, { status: 409 });
        const context = {
          sessionId: url.searchParams.get("session") ?? "session",
          generation: Number(url.searchParams.get("generation") ?? "0"),
        };
        const principal = workspaceMember(db, runner.workspaceId, runner.ownerUserId)!;
        const current = () =>
          assignments.onboardingContext(context.sessionId, context.generation, {
            workspaceId: principal.workspaceId,
            userId: principal.userId,
            role: principal.role,
            teamIds: principal.teamIds,
            authenticatedAt: Date.now(),
          }) !== null;
        if (url.searchParams.get("prepare") === "true") {
          if (!current())
            return Response.json({ error: "No current assignment." }, { status: 409 });
          await refreshRepositoryCatalog(db, async () => [
            {
              owner: "fixture-org",
              repo: "app",
              remoteUrl: "https://github.com/fixture-org/app.git",
              defaultBranch: "main",
            },
          ]);
          replaceWorkspaceRepositories(db, {
            workspaceId: runner.workspaceId,
            actorId: ownerId,
            repositories: [{ repository: "fixture-org/app", teamId: "team" }],
            now: Date.now(),
          });
          const prepared = await preparation.refresh(context, AbortSignal.timeout(10000));
          preparation.answer(context, principal, { revision: prepared.revision, mode: "code" });
        }
        const allowed = await provisioner.allowRepository(
          {
            ...context,
            workspaceId: runner.workspaceId,
            userId: runner.ownerUserId,
            runnerId: runner.id,
            repository: url.searchParams.get("repository") ?? "",
            ...(url.searchParams.has("authorized")
              ? { authorized: url.searchParams.get("authorized") === "true" }
              : {}),
            current,
          },
          AbortSignal.timeout(10000),
        );
        return Response.json({
          allowed,
          prepared: current() ? preparation.read(context) : null,
          linked: !!memberGitHubRecord(db, runner.workspaceId, runner.ownerUserId)?.secretId,
          policy: readMemberVm(db, runner.workspaceId, runner.ownerUserId),
        });
      } else return Response.json({ error: "Unknown provisioning step." }, { status: 400 });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__agent-fixture" && request.method === "POST") {
      const mode = url.searchParams.get("mode") ?? "waiting";
      for (const row of db
        .query<{ id: string; runnerId: string; agent: string }, []>(
          "SELECT id,runner_id AS runnerId,agent FROM runner_login WHERE state IN ('starting','waiting')",
        )
        .all()) {
        if (mode === "expired") {
          db.run("UPDATE runner_login SET expires_at=? WHERE id=?", [Date.now() - 1, row.id]);
          continue;
        }
        login.exchange(row.runnerId, row.id, {
          state: mode === "connected" ? "connected" : mode === "failed" ? "failed" : "waiting",
          terminal: mode === "waiting" && row.agent === "claude" ? "PRIVATE CLAUDE CHALLENGE" : "",
          authorization:
            mode === "waiting" && row.agent === "codex"
              ? {
                  url: "https://auth.openai.com/codex/device",
                  message: "PRIVATE DEVICE CODE ABCD-1234",
                }
              : null,
          inputId: mode === "waiting" ? randomUUID() : null,
        });
        if (mode === "connected") health.add(`${row.runnerId}/${row.agent}`);
      }
      return Response.json({ ok: true });
    }
    const headers = new Headers(request.headers);
    headers.set("host", new URL(configured).host);
    if (headers.has("origin")) headers.set("origin", configured);
    const internal = new Request(`${configured}${url.pathname}${url.search}`, {
      headers,
      method: request.method,
      ...(request.method === "POST" || request.method === "DELETE"
        ? { body: await request.text() }
        : {}),
    });
    const response =
      (await access.handle(internal)) ??
      (await handleStatusRequest(request, {})) ??
      new Response(null, { status: 404 });
    const location = response.headers.get("location");
    if (location?.startsWith(configured)) {
      const redirected = new Headers(response.headers);
      redirected.set("location", location.replace(configured, url.origin));
      return new Response(response.body, { status: response.status, headers: redirected });
    }
    return response;
  },
});
console.log(
  JSON.stringify({
    origin: server.url.origin,
    provisioning: "wired",
    health: simulatedHealth,
    first: { assignment: held[0]!.assignment, page: held[0]!.page },
    returning: { assignment: held[1]!.assignment, page: held[1]!.page },
  }),
);
const stopped = Promise.withResolvers<void>();
process.on("SIGTERM", () => stopped.resolve());
process.on("SIGINT", () => stopped.resolve());
const deadline = setTimeout(() => stopped.resolve(), 180000);
await stopped.promise;
clearTimeout(deadline);
clearInterval(beating);
creating.resolve();
halt.abort();
await looping;
await server.stop(true);
await access.stop();
login.stop();
writeFileSync(
  join(root, "onboarding-audit.json"),
  JSON.stringify(
    {
      assignments: db.query("SELECT session_id,generation,status FROM workspace_assignment").all(),
      progress: db.query("SELECT payload FROM outbox").all(),
      provider: exeDev.calls.map((call) =>
        call.operation === "create"
          ? { operation: call.operation, vm: call.input.name }
          : call.operation === "exec"
            ? { operation: call.operation, vm: call.input.vmName }
            : call,
      ),
      guest: guest.calls,
      repositoryPolicyCalls: guest.policyCalls,
      repositoryPolicies: guest.repositories,
      health: simulatedHealth,
      authenticatedHeartbeatProof: false,
    },
    null,
    2,
  ),
);
db.close();
