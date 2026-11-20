import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  accountSlotsInUse,
  consumeWorkspaceBootstrap,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  recordRunnerHostStatus,
  runnerOccupancy,
  syncSteps,
} from "../db";
import {
  MINIMUM_RUNNER_VERSION,
  RUNNER_SLACK_REPLY_MS,
  RUNNER_SLACK_REPLY_PROMPT_BYTES,
  type RunnerCommand,
  type RunnerHelperResult,
  type RunnerSlackReplyScope,
} from "../runner-protocol";
import { setJournalSink } from "../journal";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../workspace";
import { createRunnerHelpers } from "../runner-helpers";
import { createRunnerPlacement } from "../runner-placement";
import { createSlackReplies, SLACK_REPLY_ATTEMPTS, type SlackReplyRequest } from "./slack-reply";
import { sqlRows, sqlRun, tempStore } from "../../test/pglite";
import { signInFixtureRunner } from "../../test/pglite-fixtures";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type HelperCommand = Extract<RunnerCommand, { type: "helper" }>;

const SLACK_VERSION = MINIMUM_RUNNER_VERSION.join(".");

async function fixture(
  options: { conversations?: number; version?: string; runners?: string[] } = {},
) {
  const { db, close } = await tempStore();
  cleanup.push(close);
  const now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const otherUserId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "other",
    name: "Other",
    email: "other@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Acme",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session-1",
    teamId: "team",
    observedAtMs: now,
  });
  const runners = options.runners ?? ["runner"];
  for (const runnerId of runners) {
    await sqlRun(
      db,
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [runnerId, workspace.id, userId, runnerId, now, now],
    );
    await recordRunnerCapacity(db, runnerId, 1, 1, options.conversations ?? 2);
    await signInFixtureRunner(db, runnerId, "codex");
    await recordRunnerHostStatus(
      db,
      runnerId,
      { runnerVersion: options.version ?? SLACK_VERSION },
      now,
    );
  }
  const authority = { allowed: true, generation: 3, checks: 0 };
  const github = {
    minted: [] as Array<{ access: "read"; repository: string; installationId: string }>,
    async mintInstallationToken(input: {
      access: "read";
      repository: string;
      installationId: string;
    }) {
      github.minted.push(input);
      return {
        token: "fake-installation-token",
        expiresAt: Date.now() + 3_600_000,
        repository: input.repository,
      };
    },
  };
  const helpers = createRunnerHelpers({
    repositoryAccess: { github, installationForRepository: async () => "installation-1" },
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    slack: (_q, input) =>
      syncSteps(() => {
        authority.checks++;
        return (
          authority.allowed &&
          input.workspaceId === workspace.id &&
          input.scope.teamId === "T0ACME" &&
          input.scope.channelId === "C0GENERAL" &&
          input.scope.installGeneration === authority.generation
        );
      }),
  });
  const replies = createSlackReplies({
    store: db,
    helpers,
    placement: createRunnerPlacement({ store: db }),
    pollIntervalMs: 1,
  });
  const scope = (overrides: Partial<RunnerSlackReplyScope> = {}): RunnerSlackReplyScope => ({
    requestId: `slack-${crypto.randomUUID()}`,
    teamId: "T0ACME",
    channelId: "C0GENERAL",
    threadTs: "1795053091.151000",
    memberUserId: userId,
    installGeneration: authority.generation,
    ...overrides,
  });
  const request = () => ({
    workspaceId: workspace.id,
    scope: scope(),
    profile: { agent: "codex" as const, model: null },
    prompt: "Ada: which repositories matter?",
    timeoutMs: 5_000,
  });
  const ask = (
    overrides: Partial<RunnerSlackReplyScope> = {},
    timeoutMs = 5_000,
    tools?: SlackReplyRequest["tools"],
  ) =>
    replies.reply({
      workspaceId: workspace.id,
      scope: scope(overrides),
      profile: { agent: "codex", model: null },
      prompt: "Thread so far:\nAda: what does the release checklist cover?",
      timeoutMs,
      ...(tools ? { tools } : {}),
    });
  const result = (
    command: Pick<HelperCommand, "id" | "account">,
    overrides: Partial<RunnerHelperResult> = {},
  ): RunnerHelperResult => ({
    executionId: workspaceId(),
    commandId: command.id,
    ...(command.account ? { account: command.account } : {}),
    role: "implementer",
    stopReason: "end_turn",
    cancelled: false,
    timedOut: false,
    authRequired: false,
    agentExited: true,
    text: "It covers the changelog, the tag and the upgrade order.",
    ...overrides,
  });
  const helperCommand = async (id: string) => {
    const { command } = await helpers.current(id);
    return command as Extract<RunnerCommand, { type: "helper" }>;
  };
  async function sent(runnerId?: string) {
    for (let tick = 0; tick < 500; tick++) {
      const rows = await sqlRows<{ id: string }>(
        db,
        "SELECT id FROM runner_helper WHERE runner_id LIKE ? AND ended_at IS NULL AND result IS NULL AND purpose='slack_reply'",
        [runnerId ?? "%"],
      );
      if (rows[0]) return helperCommand(rows[0].id);
      await Bun.sleep(1);
    }
    throw new Error("Expected a Slack reply helper");
  }
  async function answer(
    runnerId = "runner",
    overrides: (id: string) => Partial<RunnerHelperResult> = () => ({}),
  ) {
    const command = await sent(runnerId);
    await helpers.acknowledge(runnerId, command.id);
    await helpers.submit(runnerId, result(command, overrides(command.id)));
    return command;
  }
  return {
    db,
    now,
    github,
    userId,
    otherUserId,
    workspace: workspace.id,
    authority,
    helpers,
    replies,
    request,
    scope,
    ask,
    answer,
    sent,
    result,
  };
}

test("a Slack reply answers through the helper lane with every work slot full", async () => {
  const f = await fixture();
  await f.helpers.dispatch({
    runnerId: "runner",
    sessionId: "session-1",
    purpose: "classify",
    profile: { agent: "codex", model: null },
    prompt: "Classify this request",
  });
  expect(await runnerOccupancy(f.db, "runner", f.now)).toEqual({ capacity: 1, occupied: 1 });

  const reply = f.ask();
  const command = await f.answer();
  const outcome = await reply;

  expect(outcome).toEqual({
    status: "answered",
    commandId: command.id,
    runnerId: "runner",
    scope: command.slack!,
    text: "It covers the changelog, the tag and the upgrade order.",
  });
  expect(command.expiresAt - command.issuedAt).toBe(RUNNER_SLACK_REPLY_MS);
  expect(command.conversation).toBeUndefined();
  expect(command.account).toBeDefined();
  expect(await runnerOccupancy(f.db, "runner", f.now)).toEqual({ capacity: 1, occupied: 1 });
  expect(await sqlRows(f.db, "SELECT id FROM work_item")).toEqual([]);
  expect(await sqlRows(f.db, "SELECT id FROM run")).toEqual([]);
  expect(
    await sqlRows(f.db, "SELECT command_id, purpose, outcome FROM runner_execution_usage"),
  ).toEqual([{ command_id: command.id, purpose: "helper", outcome: "success" }]);
  expect(
    await sqlRows(
      f.db,
      "SELECT id FROM runner_helper WHERE purpose='slack_reply' AND ended_at IS NULL",
    ),
  ).toEqual([]);
});

test("Slack replies and Linear conversations share the conversation lane", async () => {
  const f = await fixture({ conversations: 2 });
  await f.helpers.dispatch({
    runnerId: "runner",
    sessionId: "session-1",
    purpose: "conversation",
    profile: { agent: "codex", model: null },
    prompt: "What does the acme checkout do?",
    conversation: { itemId: "item-acme", runId: "run-acme", resumeSessionId: "codex-session" },
  });
  const held = f.ask();
  const first = await f.sent();
  expect(await f.ask()).toEqual({ status: "busy" });
  expect(await runnerOccupancy(f.db, "runner", f.now)).toEqual({ capacity: 1, occupied: 0 });
  await f.helpers.submit("runner", f.result(first));
  expect((await held).status).toBe("answered");
});

test("a runner with its conversation lane off refuses Slack replies", async () => {
  const f = await fixture({ conversations: 0 });
  expect((await f.ask()).status).toBe("refused");
  expect(await sqlRows(f.db, "SELECT id FROM runner_helper")).toEqual([]);
});

test("a Slack reply stops waiting at its timeout and ends its helper", async () => {
  const f = await fixture();
  expect(await f.ask({}, 30)).toEqual({ status: "timed_out" });
  expect(await sqlRows(f.db, "SELECT id FROM runner_helper WHERE ended_at IS NULL")).toEqual([]);
});

test("a runner below the minimum release gets no Slack reply", async () => {
  const f = await fixture({ version: "0.1.94" });
  expect((await f.ask()).status).toBe("refused");
  expect(await sqlRows(f.db, "SELECT id FROM runner_helper")).toEqual([]);
  expect(await f.helpers.commands("runner")).toEqual([]);
});

test("a downgraded runner cannot pick up or answer a Slack reply", async () => {
  const f = await fixture();
  const reply = f.ask();
  const command = await f.sent();
  await recordRunnerHostStatus(f.db, "runner", { runnerVersion: "0.1.94" }, Date.now());
  expect(await f.helpers.commands("runner")).toEqual([]);
  await expect(f.helpers.submit("runner", f.result(command))).rejects.toThrow(
    "Slack reply authority changed",
  );
  expect(await reply).toEqual({ status: "fenced" });
});

for (const [name, overrides] of [
  ["another member's thread", { memberUserId: "someone-else" }],
  ["another Slack team", { teamId: "T0OTHER" }],
  ["another channel", { channelId: "C0RANDOM" }],
  ["an older installation generation", { installGeneration: 2 }],
  ["a direct message", { channelId: "D0PRIVATE" }],
] as const)
  test(`a Slack reply for ${name} is refused before anything is sent`, async () => {
    const f = await fixture();
    expect((await f.ask(overrides)).status).toBe("refused");
    expect(await sqlRows(f.db, "SELECT id FROM runner_helper")).toEqual([]);
  });

test("a member without a runner of their own gets no reply", async () => {
  const f = await fixture();
  expect((await f.ask({ memberUserId: f.otherUserId })).status).toBe("refused");
  expect(await sqlRows(f.db, "SELECT id FROM runner_helper")).toEqual([]);
});

test("Slack replies stay fenced until the Slack intake supplies its authority", async () => {
  const f = await fixture();
  const helpers = createRunnerHelpers({
    store: f.db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  await expect(
    helpers.dispatch({
      runnerId: "runner",
      sessionId: "slack-request",
      purpose: "slack_reply",
      profile: { agent: "codex", model: null },
      prompt: "Hello",
      slack: f.scope({ requestId: "slack-request" }),
    }),
  ).rejects.toThrow("Slack reply authority changed");
});

test("a revoked thread is refused before dispatch", async () => {
  const f = await fixture();
  f.authority.allowed = false;
  expect((await f.ask()).status).toBe("refused");
  expect(await sqlRows(f.db, "SELECT id FROM runner_helper")).toEqual([]);
});

for (const [name, revoke] of [
  ["a revoked thread", (f: Awaited<ReturnType<typeof fixture>>) => (f.authority.allowed = false)],
  [
    "a reinstalled workspace",
    (f: Awaited<ReturnType<typeof fixture>>) => (f.authority.generation = 4),
  ],
] as const)
  test(`${name} fences the answer the runner already has`, async () => {
    const f = await fixture();
    const reply = f.ask();
    const command = await f.sent();
    await f.helpers.acknowledge("runner", command.id);
    revoke(f);
    await expect(f.helpers.acknowledge("runner", command.id)).rejects.toThrow();
    await expect(f.helpers.submit("runner", f.result(command))).rejects.toThrow(
      "Slack reply authority changed",
    );
    expect(await reply).toEqual({ status: "fenced" });
  });

async function anySent(f: Awaited<ReturnType<typeof fixture>>) {
  for (let tick = 0; tick < 500; tick++) {
    const rows = await sqlRows<{ id: string }>(
      f.db,
      "SELECT id FROM runner_helper WHERE ended_at IS NULL AND result IS NULL",
    );
    if (rows[0])
      return (await f.helpers.current(rows[0].id)).command as Extract<
        RunnerCommand,
        { type: "helper" }
      >;
    await Bun.sleep(1);
  }
  throw new Error("Expected a Slack reply helper");
}

test("a result for another command or from another runner is refused", async () => {
  const f = await fixture({ runners: ["runner", "runner-2"] });
  const reply = f.ask();
  const command = await anySent(f);
  const other = command.runnerId === "runner" ? "runner-2" : "runner";
  await expect(f.helpers.submit(other, f.result(command))).rejects.toThrow();
  const response = await f.helpers.fetch(
    new Request(`https://paws.invalid/v1/helper-commands/${command.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f.result({ ...command, id: "another-command" })),
    }),
    command.runnerId,
  );
  expect(response?.status).toBe(403);
  await f.helpers.submit(command.runnerId, f.result(command));
  await expect(
    f.helpers.submit(command.runnerId, f.result(command, { text: "A different answer." })),
  ).rejects.toThrow("immutable");
  expect((await reply).status).toBe("answered");
});

test("an answer that uses the reply tool is not handed back", async () => {
  const f = await fixture();
  const reply = f.ask();
  await f.answer("runner", () => ({ replies: ["Posted elsewhere"] }));
  expect((await reply).status).toBe("failed");
});

test("a notes block may add up to 20,000 characters to an answer of up to 12,000", async () => {
  const notes = (size: number) => `\n\`\`\`paws-notes\n[${" ".repeat(size)}]\n\`\`\``;
  for (const [text, status] of [
    ["a".repeat(12_000) + notes(19_000), "answered"],
    ["a".repeat(12_001) + notes(10), "failed"],
    ["a".repeat(100) + notes(20_000), "failed"],
  ] as const) {
    const f = await fixture();
    const reply = f.ask();
    await f.answer("runner", () => ({ text }));
    expect((await reply).status).toBe(status);
  }
});

test("a failed agent is retried once on another runner", async () => {
  const f = await fixture({ runners: ["runner", "runner-2"] });
  const reply = f.ask();
  const first = await f.sent();
  expect(await accountSlotsInUse(f.db, first.account!.accountId, Date.now())).toBe(1);
  await f.helpers.submit(
    first.runnerId,
    f.result(first, { stopReason: "error", authRequired: true, text: "" }),
  );
  const second = await f.answer(first.runnerId === "runner" ? "runner-2" : "runner");
  const outcome = await reply;
  expect(outcome.status).toBe("answered");
  expect(outcome.status === "answered" && outcome.commandId).toBe(second.id);
  expect(
    await sqlRows(
      f.db,
      "SELECT command_id, outcome FROM runner_execution_usage ORDER BY started_at, command_id",
    ),
  ).toEqual(
    expect.arrayContaining([
      { command_id: first.id, outcome: "auth_required" },
      { command_id: second.id, outcome: "success" },
    ]),
  );
  expect(await accountSlotsInUse(f.db, first.account!.accountId, Date.now())).toBe(0);
});

test("retries stop after the attempt budget", async () => {
  const f = await fixture({ runners: ["runner", "runner-2", "runner-3"] });
  const reply = f.ask();
  const ran = new Set<string>();
  for (let attempt = 0; attempt < SLACK_REPLY_ATTEMPTS; attempt++) {
    let command: Extract<RunnerCommand, { type: "helper" }> | undefined;
    for (let tick = 0; !command && tick < 500; tick++) {
      for (const runnerId of ["runner", "runner-2", "runner-3"])
        if (!ran.has(runnerId)) {
          const rows = await sqlRows<{ id: string }>(
            f.db,
            "SELECT id FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND result IS NULL",
            [runnerId],
          );
          if (rows[0]) command = (await f.helpers.current(rows[0].id)).command as never;
        }
      if (!command) await Bun.sleep(1);
    }
    ran.add(command!.runnerId);
    await f.helpers.submit(
      command!.runnerId,
      f.result(command!, { stopReason: "error", errorMessage: "Agent crashed", text: "" }),
    );
  }
  expect(await reply).toEqual({ status: "failed", reason: "Agent crashed" });
  expect((await sqlRows(f.db, "SELECT id FROM runner_helper")).length).toBe(SLACK_REPLY_ATTEMPTS);
});

test("a Slack reply's thread context is bounded", async () => {
  const f = await fixture();
  const outcome = await createSlackReplies({
    store: f.db,
    helpers: f.helpers,
    placement: createRunnerPlacement({ store: f.db }),
  }).reply({
    workspaceId: f.workspace,
    scope: f.scope(),
    profile: { agent: "codex", model: null },
    prompt: "x".repeat(RUNNER_SLACK_REPLY_PROMPT_BYTES + 1),
  });
  expect(outcome.status).toBe("refused");
  expect(await sqlRows(f.db, "SELECT id FROM runner_helper")).toEqual([]);
});

const definitions = [{ name: "linear_issue", description: "Read an issue.", inputSchema: {} }];

async function toolRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  runnerId: string,
  id: string,
  body: { requestId: string; name: string; arguments: Record<string, string> },
) {
  const response = await f.helpers.fetch(
    new Request(`http://paws/v1/helper-commands/${id}/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    runnerId,
  );
  return { status: response!.status, body: (await response!.json()) as Record<string, unknown> };
}

test("a Slack reply's tool requests reach its handler only while it waits", async () => {
  const f = await fixture({ runners: ["runner", "other"] });
  const calls: string[] = [];
  const reply = f.ask({}, 5_000, {
    definitions,
    call: async (name, args) => {
      calls.push(`${name}:${String(args.id)}`);
      return { text: `Issue ${String(args.id)} is open.` };
    },
  });
  const command = await f.sent();
  expect(command.tools).toEqual(definitions);
  const ask = (requestId: string, name = "linear_issue", runnerId = command.runnerId) =>
    toolRequest(f, runnerId, command.id, { requestId, name, arguments: { id: requestId } });

  expect(await ask("r1")).toEqual({ status: 200, body: { text: "Issue r1 is open." } });
  expect(await ask("r1")).toEqual({ status: 200, body: { text: "Issue r1 is open." } });
  expect(calls).toEqual(["linear_issue:r1"]);
  const otherRunner = command.runnerId === "runner" ? "other" : "runner";
  for (const refused of [
    await ask("r2", "linear_team"),
    await ask("r2", "linear_issue", otherRunner),
  ])
    expect(refused).toEqual({ status: 409, body: expect.objectContaining({ code: "fenced" }) });
  for (let i = 2; i <= 64; i++) await ask(`r${i}`);
  expect(calls).toHaveLength(64);
  expect(await ask("r65")).toEqual({
    status: 200,
    body: { text: "This run has used all its tool calls.", isError: true },
  });
  expect(calls).toHaveLength(64);

  await f.helpers.acknowledge(command.runnerId, command.id);
  await f.helpers.submit(command.runnerId, f.result(command));
  expect((await reply).status).toBe("answered");
  expect((await ask("r66")).status).toBe(409);
  expect(calls).toHaveLength(64);
});

test("a tool request with no handler gets 409 and a failed handler an error answer", async () => {
  const f = await fixture();
  const { command } = await f.helpers.dispatch({
    runnerId: "runner",
    sessionId: "slack-unhandled",
    purpose: "slack_reply",
    profile: { agent: "codex", model: null },
    prompt: "Ada: what is open?",
    slack: f.scope({ requestId: "slack-unhandled" }),
    tools: definitions,
  });
  const body = { requestId: "r1", name: "linear_issue", arguments: {} };
  expect(await toolRequest(f, "runner", command.id, body)).toEqual({
    status: 409,
    body: expect.objectContaining({ code: "fenced" }),
  });
  const remove = f.helpers.handle(command.id, () => Promise.reject(new Error("Linear is down")));
  expect((await toolRequest(f, "runner", command.id, body)).body).toEqual({
    text: "Paws could not answer that tool.",
    isError: true,
  });
  remove();
  f.helpers.handle(command.id, async () => ({ text: "é".repeat(10_000) }));
  const long = await toolRequest(f, "runner", command.id, { ...body, requestId: "r2" });
  expect(Buffer.byteLength(long.body.text as string)).toBe(16_384);
});

test("a Slack reply removes its tool handler when it fails or times out", async () => {
  const f = await fixture();
  const events: string[] = [];
  const handle = f.helpers.handle;
  f.helpers.handle = (id, handler) => {
    events.push(`add:${id}`);
    const remove = handle(id, handler);
    return () => {
      events.push(`remove:${id}`);
      remove();
    };
  };
  const tools = { definitions, call: async () => ({ text: "open" }) };
  const reply = f.ask({}, 5_000, tools);
  const command = await f.sent();
  expect(events).toEqual([`add:${command.id}`]);
  await f.helpers.acknowledge("runner", command.id);
  await f.helpers.submit(
    "runner",
    f.result(command, { errorMessage: "agent crashed", agentExited: false }),
  );
  expect((await reply).status).toBe("failed");
  expect(events).toEqual([`add:${command.id}`, `remove:${command.id}`]);
  events.length = 0;
  expect(await f.ask({}, 30, tools)).toEqual({ status: "timed_out" });
  expect(events).toHaveLength(2);
  expect(events[1]).toBe(events[0]!.replace("add:", "remove:"));
});

const COMMIT = "a".repeat(40);

async function credentialRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  runnerId: string,
  id: string,
  repository: string,
) {
  const response = await f.helpers.fetch(
    new Request(`http://paws/v1/helper-commands/${id}/repository-credential`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository }),
    }),
    runnerId,
  );
  return { status: response!.status, body: (await response!.json()) as Record<string, unknown> };
}

test("a Slack reply's repository handler grants up to five repositories with their commits", async () => {
  const f = await fixture({ runners: ["runner", "other"] });
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    const asked: string[] = [];
    const reply = f.replies.reply({
      ...f.request(),
      repositories: async (name) => {
        asked.push(name);
        return name === "acme/secret" ? null : { commit: COMMIT };
      },
    });
    const command = await f.sent();
    const ask = (repository: string, runnerId = command.runnerId) =>
      credentialRequest(f, runnerId, command.id, repository);

    expect(await ask("acme/web")).toEqual({
      status: 200,
      body: {
        token: "fake-installation-token",
        expiresAt: expect.any(Number),
        remoteUrl: "https://github.com/acme/web.git",
        branch: null,
        commit: COMMIT,
      },
    });
    expect(f.github.minted).toEqual([
      { access: "read", repository: "acme/web", installationId: "installation-1" },
    ]);
    expect(await ask("acme/secret")).toEqual({
      status: 403,
      body: expect.objectContaining({ code: "forbidden" }),
    });
    const otherRunner = command.runnerId === "runner" ? "other" : "runner";
    expect((await ask("acme/api", otherRunner)).status).toBe(409);
    for (const name of ["acme/a", "acme/b", "acme/c", "acme/d"])
      expect((await ask(name)).status).toBe(200);
    expect(await ask("acme/e")).toEqual({
      status: 403,
      body: expect.objectContaining({ code: "forbidden" }),
    });
    expect((await ask("acme/web")).status).toBe(200);
    expect(asked).not.toContain("acme/e");
    expect(f.github.minted).toHaveLength(6);

    await f.helpers.acknowledge(command.runnerId, command.id);
    await f.helpers.submit(command.runnerId, f.result(command));
    expect((await reply).status).toBe("answered");
    expect((await ask("acme/web")).status).toBe(409);
    expect(f.github.minted).toHaveLength(6);
    expect(lines.filter((line) => line.includes("repository-credential"))).toContain(
      `helper repository-credential command=${command.id} repository=acme/web`,
    );
    expect(lines.join("\n")).not.toContain("fake-installation-token");
    expect(JSON.stringify(await sqlRows(f.db, "SELECT * FROM runner_helper"))).not.toContain(
      "fake-installation-token",
    );
  } finally {
    restore();
  }
});

test("a repository credential is forbidden with no handler or for another purpose", async () => {
  const f = await fixture();
  const { command } = await f.helpers.dispatch({
    runnerId: "runner",
    sessionId: "slack-bare",
    purpose: "slack_reply",
    profile: { agent: "codex", model: null },
    prompt: "Ada: what is open?",
    slack: f.scope({ requestId: "slack-bare" }),
  });
  expect((await credentialRequest(f, "runner", command.id, "acme/web")).body).toEqual(
    expect.objectContaining({ code: "forbidden" }),
  );
  f.helpers.handle(command.id, undefined, async () => ({ commit: "not-a-commit" }));
  expect((await credentialRequest(f, "runner", command.id, "acme/web")).status).toBe(403);
  await f.helpers.finish(command.id);
  const classify = await f.helpers.dispatch({
    runnerId: "runner",
    sessionId: "session-1",
    purpose: "classify",
    profile: { agent: "codex", model: null },
    prompt: "Classify this request",
  });
  f.helpers.handle(classify.command.id, undefined, async () => ({ commit: COMMIT }));
  expect(await credentialRequest(f, "runner", classify.command.id, "acme/web")).toEqual({
    status: 403,
    body: expect.objectContaining({ code: "forbidden" }),
  });
  expect(f.github.minted).toEqual([]);
});
