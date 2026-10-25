import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  listRunnerAgents,
  migrate,
  openDatabase,
  putWorkspaceUser,
  saveAgentVersions,
  type AgentVersionRow,
  type RunnerAgentView,
} from "../src/db";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const integrity = (seed: string) => `sha512-${seed.repeat(86).slice(0, 86)}==`;
const DAY = 24 * 60 * 60 * 1000;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-agents-"));
  roots.push(root);
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  let now = 1_800_000_000_000;
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-host", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-host",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal: WorkspacePrincipal = {
    workspaceId: workspace.id,
    userId,
    role: "owner",
    authenticatedAt: now,
    teamIds: [],
  };
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
    serverVersion: "2.3.4",
  });
  const pair = async (name: string) => {
    const client = await createRunnerKey(join(root, name));
    const pending = await control.beginPairing({ name, csr: client.csr });
    now += 1;
    return (await control.approvePairing(principal, pending.code)).runnerId;
  };
  const runnerId = await pair("goldbox");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const http = createRunnerWorkHttp(work, {});
  const browser = createRunnerHttp(control);
  // The catalog: Claude 2.1.0 eligible, 2.2.0 still inside its 48 hours, 1.9.0 refused.
  const row = (agent: string, version: string, status: AgentVersionRow["status"], seed: string) =>
    ({
      agent,
      version,
      publishedAt: now - 5 * DAY,
      integrity: integrity(seed),
      status,
      firstSeenAt: now - 5 * DAY,
      reason: status === "eligible" ? null : `${agent}@${version} is ${status}.`,
      nativeVersion: status === "eligible" ? `${version}-native` : null,
      checkedAt: now,
    }) satisfies AgentVersionRow;
  saveAgentVersions(db, [
    row("claude", "2.0.0", "eligible", "A"),
    row("claude", "2.1.0", "eligible", "B"),
    row("claude", "2.2.0", "waiting", "C"),
    row("claude", "1.9.0", "refused", "D"),
    row("codex", "0.9.0", "eligible", "E"),
  ]);
  const post = async (path: string, body?: unknown) => {
    const response = (await browser.browser(
      new Request(`https://paws.invalid${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
      principal,
    ))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    db,
    runnerId,
    pair,
    heartbeat: async (body: unknown, id = runnerId) => {
      const response = await http(
        new Request("https://runner.invalid/v1/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        id,
      );
      return {
        status: response!.status,
        body: (response!.status === 200 ? await response!.json() : null) as {
          agents?: unknown[];
        } | null,
      };
    },
    list: async () =>
      (await (await browser.browser(
        new Request("https://paws.invalid/api/runners"),
        principal,
      ))!.json()) as { runners: { id: string; codingAgents: RunnerAgentView[] }[] },
    update: (agent: string, version: string, id = runnerId) =>
      post(`/api/runners/${id}/coding-agents/${agent}/update`, { version }),
    rollback: (agent: string, id = runnerId) =>
      post(`/api/runners/${id}/coding-agents/${agent}/rollback`),
    updateAll: () => post("/api/runners/coding-agents/update-all"),
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

const installed = [
  { agent: "claude", version: "2.0.0", status: "current" },
  { agent: "claude", version: "1.8.0", status: "previous" },
  { agent: "codex", version: "0.9.0", status: "current" },
] as const;

test("a heartbeat with agents is stored and shown on the runner card", async () => {
  const runner = await fixture();
  // A runner that does not report agents gets no agent targets back.
  expect((await runner.heartbeat({}))?.body).not.toHaveProperty("agents");
  const reply = await runner.heartbeat({ agents: installed });
  expect(reply.status).toBe(200);
  expect(reply.body?.agents).toEqual([]);
  const expected: RunnerAgentView[] = [
    {
      agent: "claude",
      current: "2.0.0",
      previous: "1.8.0",
      pending: null,
      reportedAt: runner.now(),
    },
    { agent: "codex", current: "0.9.0", previous: null, pending: null, reportedAt: runner.now() },
  ];
  expect(listRunnerAgents(runner.db, runner.runnerId)).toEqual(expected);
  expect((await runner.list()).runners[0]!.codingAgents).toEqual(expected);
});

test("a malformed agent report is refused", async () => {
  const runner = await fixture();
  for (const agent of [
    { agent: "left-pad", version: "1.0.0", status: "current" },
    { agent: "claude", version: "../1", status: "current" },
    { agent: "claude", version: "1.0.0", status: "ready" },
    { agent: "claude", version: "1.0.0", status: "failed", error: "x".repeat(501) },
  ])
    expect((await runner.heartbeat({ agents: [agent] })).status).toBe(403);
  expect(listRunnerAgents(runner.db, runner.runnerId)).toEqual([]);
});

test("Update sends the eligible version with its integrity, and the card follows the install", async () => {
  const runner = await fixture();
  await runner.heartbeat({ agents: installed });
  expect(await runner.update("claude", "2.1.0")).toEqual({
    status: 200,
    body: { ok: true, version: "2.1.0" },
  });
  const sent = (await runner.heartbeat({ agents: installed })).body!.agents as {
    id: string;
  }[];
  expect(sent).toEqual([
    {
      id: expect.any(String),
      agent: "claude",
      version: "2.1.0",
      integrity: integrity("B"),
      nativeVersion: "2.1.0-native",
    },
  ]);
  const target = sent[0]!.id;
  const pending = async () =>
    listRunnerAgents(runner.db, runner.runnerId).find((entry) => entry.agent === "claude")!.pending;
  expect(await pending()).toMatchObject({ version: "2.1.0", status: "requested" });

  await runner.heartbeat({
    agents: [...installed, { agent: "claude", version: "2.1.0", status: "installing", target }],
  });
  expect(await pending()).toMatchObject({ status: "installing", sessions: null });

  // A running session keeps 2.0.0: the runner waits, and Paws keeps sending the target.
  const waiting = await runner.heartbeat({
    agents: [
      ...installed,
      { agent: "claude", version: "2.1.0", status: "waiting", target, sessions: 2 },
    ],
  });
  expect(waiting.body!.agents).toHaveLength(1);
  expect(await pending()).toMatchObject({ status: "waiting", sessions: 2 });

  // Once the sessions end the runner switches; the target is done and no longer sent.
  const done = await runner.heartbeat({
    agents: [
      { agent: "claude", version: "2.1.0", status: "current" },
      { agent: "claude", version: "2.0.0", status: "previous" },
      { agent: "codex", version: "0.9.0", status: "current" },
    ],
  });
  expect(done.body!.agents).toEqual([]);
  expect(listRunnerAgents(runner.db, runner.runnerId)[0]).toMatchObject({
    current: "2.1.0",
    previous: "2.0.0",
    pending: null,
  });
});

test("an install the runner reports failed shows its error until someone asks again", async () => {
  const runner = await fixture();
  await runner.heartbeat({ agents: installed });
  await runner.update("claude", "2.1.0");
  const [first] = (await runner.heartbeat({ agents: installed })).body!.agents as {
    id: string;
  }[];
  const error =
    "Coding agent claude 2.1.0 was not installed: npm's integrity is not the one Paws sent";
  await runner.heartbeat({
    agents: [
      ...installed,
      { agent: "claude", version: "2.1.0", status: "failed", target: first!.id, error },
    ],
  });
  expect(listRunnerAgents(runner.db, runner.runnerId)[0]!.pending).toMatchObject({
    status: "failed",
    error,
  });
  runner.advance(1000);
  await runner.update("claude", "2.1.0");
  const [second] = (
    await runner.heartbeat({
      agents: [
        ...installed,
        { agent: "claude", version: "2.1.0", status: "failed", target: first!.id, error },
      ],
    })
  ).body!.agents as { id: string }[];
  expect(second!.id).not.toBe(first!.id);
  expect(listRunnerAgents(runner.db, runner.runnerId)[0]!.pending).toMatchObject({
    status: "requested",
    error: null,
  });
});

test("a version that is not eligible cannot be chosen", async () => {
  const runner = await fixture();
  await runner.heartbeat({ agents: installed });
  for (const [version, message] of [
    ["2.2.0", "Claude 2.2.0 is not an eligible version: claude@2.2.0 is waiting."],
    ["1.9.0", "Claude 1.9.0 is not an eligible version: claude@1.9.0 is refused."],
    ["3.0.0", "Claude 3.0.0 is not an eligible version."],
    ["2.0.0", "This runner already runs Claude 2.0.0."],
  ] as const)
    expect(await runner.update("claude", version)).toEqual({
      status: 400,
      body: { error: message },
    });
  expect((await runner.update("grok", "1.0.0")).body).toEqual({
    error: "This runner does not report Grok. Update the runner package first.",
  });
  expect((await runner.update("claude", "latest")).status).toBe(403);
  expect((await runner.heartbeat({ agents: installed })).body!.agents).toEqual([]);

  // A version that stops being eligible after it was chosen is no longer sent.
  await runner.update("claude", "2.1.0");
  runner.db.run("UPDATE agent_version SET status='refused', reason=? WHERE version='2.1.0'", [
    "Its integrity changed.",
  ]);
  expect((await runner.heartbeat({ agents: installed })).body!.agents).toEqual([]);
  expect(listRunnerAgents(runner.db, runner.runnerId)[0]!.pending).toMatchObject({
    status: "failed",
    error: "Paws no longer offers Claude 2.1.0: Its integrity changed.",
  });
});

test("Roll back sends the previous version without an integrity, so nothing downloads", async () => {
  const runner = await fixture();
  await runner.heartbeat({ agents: installed });
  expect(await runner.rollback("claude")).toEqual({
    status: 200,
    body: { ok: true, version: "1.8.0" },
  });
  expect((await runner.heartbeat({ agents: installed })).body!.agents).toEqual([
    {
      id: expect.any(String),
      agent: "claude",
      version: "1.8.0",
      integrity: null,
      nativeVersion: null,
    },
  ]);
  expect(listRunnerAgents(runner.db, runner.runnerId)[0]!.pending).toMatchObject({
    version: "1.8.0",
    rollback: true,
  });
  await runner.heartbeat({
    agents: [
      { agent: "claude", version: "1.8.0", status: "current" },
      { agent: "claude", version: "2.0.0", status: "previous" },
    ],
  });
  expect(listRunnerAgents(runner.db, runner.runnerId)[0]).toMatchObject({
    current: "1.8.0",
    previous: "2.0.0",
    pending: null,
  });
  expect((await runner.rollback("codex")).body).toEqual({
    error: "This runner has no earlier Codex version to roll back to.",
  });
  await runner.heartbeat({
    agents: [
      { agent: "claude", version: "2.0.0", status: "current" },
      { agent: "claude", version: "1.9.0", status: "previous" },
    ],
  });
  expect((await runner.rollback("claude")).body).toEqual({
    error: "Paws refused Claude 1.9.0, so it cannot be rolled back to: claude@1.9.0 is refused.",
  });
});

test("Update all runners sends every runner the newest eligible version it lacks", async () => {
  const runner = await fixture();
  const second = await runner.pair("silverbox");
  await runner.heartbeat({ agents: installed });
  await runner.heartbeat(
    {
      agents: [
        { agent: "claude", version: "2.1.0", status: "current" },
        { agent: "codex", version: "0.8.0", status: "current" },
      ],
    },
    second,
  );
  expect(await runner.updateAll()).toEqual({ status: 200, body: { requested: 2 } });
  const versions = async (id: string) =>
    (
      (await runner.heartbeat({ agents: [] }, id)).body!.agents as {
        agent: string;
        version: string;
      }[]
    ).map((target) => `${target.agent}@${target.version}`);
  expect(await versions(runner.runnerId)).toEqual(["claude@2.1.0"]);
  expect(await versions(second)).toEqual(["codex@0.9.0"]);
  // Asking again does not replace a request already on its way.
  expect((await runner.updateAll()).body).toEqual({ requested: 0 });
});
