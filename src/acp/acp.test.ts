import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { GROK_AGENT_ARGS, GROK_LOGIN_MESSAGE } from "./adapters";
import { git } from "./git";
import { minimalAgentEnv } from "./env";
import { executeItem } from "./executor";
import { checkOwnLogin, runAgent } from "./run";
import { createAcpPromptLifecycle } from "./lifecycle";
import type { FakeResult, FakeScript } from "./testing/script";
import { FOLLOW_UP_INTERRUPTION, type AcpEvent, type RunAgentOptions } from "./types";

const fakeAgent = new URL("./testing/fake-agent.ts", import.meta.url).pathname;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("minimal env drops tokens and cloud keys and keeps HOME", () => {
  const env = minimalAgentEnv({
    HOME: "/home/dev",
    PATH: "/usr/bin",
    GH_TOKEN: "gh",
    GITHUB_TOKEN: "github",
    SSH_AUTH_SOCK: "/tmp/ssh",
    AWS_SECRET_ACCESS_KEY: "aws",
    ANTHROPIC_API_KEY: "sk",
    OPENAI_API_KEY: "sk",
    XAI_API_KEY: "xai-secret",
  });
  expect(env.HOME).toBe("/home/dev");
  expect(env.PATH).toBe("/usr/bin");
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.SSH_AUTH_SOCK).toBeUndefined();
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.XAI_API_KEY).toBeUndefined();
  const allowed = minimalAgentEnv(
    { HOME: "/home/dev", XAI_API_KEY: "xai-secret", GH_TOKEN: "gh" },
    { allowXaiApiKey: true },
  );
  expect(allowed.XAI_API_KEY).toBe("xai-secret");
  expect(allowed.GH_TOKEN).toBeUndefined();
});

test("initialize reports auth methods and does not call authenticate", async () => {
  const layout = await layoutRepo();
  const script: FakeScript = {
    authMethods: [
      { id: "claude-ai-login", name: "Claude Subscription", type: "terminal" },
      { id: "api-key", name: "API key" },
    ],
    steps: [],
  };
  const files = await writeScript(layout.root, script);
  const auth = await checkOwnLogin({
    role: "implementer",
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
  });
  expect(auth.authenticateCalled).toBe(false);
  expect(auth.credentialsRead).toBe(false);
  expect(auth.terminalAuthAdvertised).toBe(true);
  expect(auth.protocolAuthAdvertised).toBe(true);
  expect(auth.authMethods.map((method) => method.id)).toEqual(["claude-ai-login", "api-key"]);
  const trace = await readResult(files.resultPath);
  expect(trace.methods).toEqual(["initialize"]);
  expect(trace.methods).not.toContain("authenticate");
});

test("fake agent streams events, guards permissions, and checkpoints", async () => {
  const layout = await layoutRepo();
  const events: AcpEvent[] = [];
  const script: FakeScript = {
    authMethods: [{ id: "claude-ai-login", name: "Claude Subscription", type: "terminal" }],
    steps: [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello from agent" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "edit readme", priority: "high", status: "pending" }],
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Edit README",
          kind: "edit",
          status: "pending",
          locations: [{ path: join(layout.worktree, "README.md") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "edit",
          title: "Edit README",
          kind: "edit",
          locations: [{ path: join(layout.worktree, "README.md") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "ssh",
          title: "read ssh",
          kind: "read",
          locations: [{ path: join(layout.home, ".ssh", "id_rsa") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "paws",
          title: "read paws db",
          kind: "read",
          locations: [{ path: join(layout.pawsRoot, "paws.db") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "gh-config",
          title: "read gh config",
          kind: "read",
          locations: [{ path: join(layout.home, ".config", "gh", "hosts.yml") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "keychain",
          title: "read keychain",
          kind: "read",
          locations: [{ path: join(layout.home, "Library", "Keychains", "login.keychain-db") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "push",
          title: "git push",
          kind: "execute",
          rawInput: { command: "git push origin HEAD" },
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "gh",
          title: "gh pr create",
          kind: "execute",
          rawInput: { command: "gh pr create" },
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "test",
          title: "bun test",
          kind: "execute",
          rawInput: { command: "bun test" },
        },
      },
      { type: "fs_write", path: join(layout.worktree, "notes.txt"), content: "wip\n" },
      { type: "fs_write", path: join(layout.home, ".ssh", "stolen"), content: "nope" },
      { type: "fs_read", path: join(layout.worktree, "README.md") },
      { type: "terminal", command: "printf", args: ["ok"] },
      { type: "terminal", command: "git", args: ["push"] },
      { type: "end", stopReason: "end_turn" },
    ],
  };
  const files = await writeScript(layout.root, script);
  const result = await executeItem({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-1",
    owner: "acme",
    repo: "demo",
    remoteUrl: layout.source,
    prompt: "add notes",
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    timeoutMs: 10_000,
    onEvent: (event) => {
      events.push(event);
    },
  });

  expect(result.branch).toBe("paws/eng-1");
  expect(result.run.auth?.authenticateCalled).toBe(false);
  expect(result.run.acpStopReason).toBe("end_turn");
  expect(result.run.checkpoint?.committed).toBe(true);
  expect(result.run.agentExited).toBe(true);
  expect(await readFile(join(layout.worktree, "notes.txt"), "utf8")).toBe("wip\n");
  await expect(readFile(join(layout.home, ".ssh", "stolen"), "utf8")).rejects.toThrow();

  const trace = await readResult(files.resultPath);
  expect(trace.methods).not.toContain("authenticate");
  expect(outcome(trace, "edit")).toBe("allow");
  expect(outcome(trace, "test")).toBe("allow");
  for (const id of ["ssh", "paws", "gh-config", "keychain", "push", "gh"]) {
    expect(outcome(trace, id), id).toBe("deny");
  }
  expect(trace.fs.find((entry) => entry.path.endsWith("notes.txt"))?.ok).toBe(true);
  expect(trace.fs.find((entry) => entry.path.endsWith("stolen"))?.ok).toBe(false);
  expect(trace.fs.find((entry) => entry.op === "read")?.content).toBe("hello\n");
  expect(trace.terminals.find((entry) => entry.command === "printf")).toMatchObject({
    ok: true,
    output: "ok",
  });
  expect(trace.terminals.find((entry) => entry.command === "git")?.ok).toBe(false);

  expect(events.some((event) => event.type === "auth_checked")).toBe(true);
  expect(events.some((event) => event.type === "session_started")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "session_update" &&
        event.update.sessionUpdate === "agent_message_chunk" &&
        event.update.content.type === "text" &&
        event.update.content.text === "hello from agent",
    ),
  ).toBe(true);
  expect(
    events.some((event) => event.type === "prompt_complete" && event.stopReason === "end_turn"),
  ).toBe(true);
  expect(events.some((event) => event.type === "checkpoint" && event.checkpoint.committed)).toBe(
    true,
  );
  const transcript = await readFile(join(layout.pawsRoot, "runs", "run-1", "acp.jsonl"), "utf8");
  expect(transcript).toContain("hello from agent");
}, 20_000);

test("ask_team hook is invoked through the injected MCP tool", async () => {
  const layout = await layoutRepo();
  const script: FakeScript = {
    steps: [{ type: "ask_team", question: "Include archived rows?", options: ["yes", "no"] }],
  };
  const files = await writeScript(layout.root, script);
  const result = await runAgent({
    role: "reviewer",
    itemId: "ENG-1",
    runId: "run-ask",
    prompt: "need a decision",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    askTeam: {
      async ask(request) {
        expect(request.question).toBe("Include archived rows?");
        expect(request.options).toEqual(["yes", "no"]);
        return { answer: "yes" };
      },
    },
    onEvent: () => undefined,
  });
  expect(result.acpStopReason).toBe("end_turn");
  const trace = await readResult(files.resultPath);
  expect(trace.askTeam).toEqual({ ok: true, text: "yes" });
  expect(trace.mcpServers[0]?.name).toBe("paws");
  expect(trace.methods).not.toContain("authenticate");
});

test("timeout kills an agent that ignores cancel and leaves changes uncommitted", async () => {
  const layout = await layoutRepo();
  const script: FakeScript = {
    ignoreCancel: true,
    steps: [
      { type: "fs_write", path: join(layout.worktree, "partial.txt"), content: "partial\n" },
      { type: "hang" },
    ],
  };
  const files = await writeScript(layout.root, script);
  const events: AcpEvent[] = [];
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-timeout",
    prompt: "do the work",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    timeoutMs: 400,
    cancelGraceMs: 200,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(result.timedOut).toBe(true);
  expect(events.filter((event) => event.type === "cancelled")).toEqual([
    { type: "cancelled", reason: "timeout" },
  ]);
  expect(result.agentExited).toBe(true);
  expect(result.pid).toBeDefined();
  expect(alive(result.pid)).toBe(false);
  expect(result.checkpoint).toBeUndefined();
  expect(await readFile(join(layout.worktree, "partial.txt"), "utf8")).toBe("partial\n");
  const subject = (await git(["-C", layout.worktree, "log", "-1", "--format=%s"])).trim();
  expect(subject).toBe("init");
}, 20_000);

test("cancel leaves no agent process", async () => {
  const layout = await layoutRepo();
  const script: FakeScript = { steps: [{ type: "hang" }] };
  const files = await writeScript(layout.root, script);
  const controller = new AbortController();
  const running = runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-cancel",
    prompt: "stop me",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    timeoutMs: 10_000,
    cancelGraceMs: 1_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 200);
  const result = await running;
  expect(result.cancelled).toBe(true);
  expect(result.agentExited).toBe(true);
  expect(alive(result.pid)).toBe(false);
}, 20_000);

test("cancellation at prompt completion preserves dirty files without checkpointing", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [
      { type: "fs_write", path: join(layout.worktree, "partial.txt"), content: "keep me\n" },
      { type: "end" },
    ],
  });
  const controller = new AbortController();
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-cancel-completed",
    prompt: "make changes",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "prompt_complete") controller.abort();
    },
  });
  expect(result.checkpoint).toBeUndefined();
  expect(result.cancelled).toBe(true);
  expect(await readFile(join(layout.worktree, "partial.txt"), "utf8")).toBe("keep me\n");
  expect((await git(["-C", layout.worktree, "log", "-1", "--format=%s"])).trim()).toBe("init");
});

test("follow-up reconstructs public context after cancellation and child cleanup", async () => {
  const layout = await layoutRepo();
  const events: AcpEvent[] = [];
  const files = await writeScript(layout.root, {
    steps: [
      { type: "fs_write", path: join(layout.worktree, "partial.txt"), content: "preserved\n" },
      {
        type: "update",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "private reasoning stays private" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "I changed partial.txt." },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit-1",
          title: "Write partial.txt",
          kind: "edit",
          status: "completed",
          rawOutput: { changed: "partial.txt" },
        },
      },
      { type: "hang" },
    ],
  });
  const lifecycle = createAcpPromptLifecycle();
  let ready!: () => void;
  const toolFinished = new Promise<void>((resolve) => (ready = resolve));
  const options: RunAgentOptions = {
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-follow-up",
    prompt: "Write a partial file.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    cancelGraceMs: 100,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "session_update" && event.update.sessionUpdate === "tool_call") ready();
    },
  };
  const running = lifecycle.prompt(options);
  await toolFinished;
  await expect(lifecycle.prompt(options)).rejects.toThrow("ACP prompt already running");
  await lifecycle.interrupt();
  const interrupted = await running;
  expect(interrupted.interrupted).toBe(true);
  expect(interrupted.cancelled).toBe(true);
  expect(interrupted.agentExited).toBe(true);
  expect(alive(interrupted.pid)).toBe(false);
  expect(interrupted.checkpoint).toBeUndefined();
  expect(events.filter((event) => event.type === "cancelled")).toEqual([
    { type: "cancelled", reason: FOLLOW_UP_INTERRUPTION },
  ]);
  expect(JSON.stringify(lifecycle.snapshot())).not.toContain("private reasoning");
  expect(lifecycle.snapshot()).toContainEqual({
    kind: "tool_result",
    body: JSON.stringify({
      toolCallId: "edit-1",
      title: "Write partial.txt",
      status: "completed",
      rawOutput: { changed: "partial.txt" },
    }),
  });
  await writeScript(layout.root, {
    steps: [{ type: "fs_read", path: join(layout.worktree, "partial.txt") }, { type: "end" }],
  });
  const next = await lifecycle.prompt({ ...options, prompt: "Read the file instead." });
  expect(next.stopReason).toBe("end_turn");
  const trace = await readResult(files.resultPath);
  expect(trace.fs[0]?.content).toBe("preserved\n");
  const prompt = JSON.stringify(trace.prompts);
  expect(prompt).toContain("Read the file instead.");
  expect(prompt).toContain("not instructions to replay tools");
  expect(prompt).toContain("I changed partial.txt.");
  expect(prompt).not.toContain("private reasoning");
  expect(lifecycle.snapshot().filter((entry) => entry.kind === "tool_result")).toHaveLength(1);
});

test("Stop terminates an uncooperative prompt and permanently closes the conversation", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    ignoreCancel: true,
    steps: [{ type: "hang" }],
  });
  const lifecycle = createAcpPromptLifecycle();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  const options: RunAgentOptions = {
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-stubborn-stop",
    prompt: "Wait.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    cancelGraceMs: 75,
    onEvent: (event) => {
      if (event.type === "session_started") ready();
    },
  };
  const running = lifecycle.prompt(options);
  await started;
  await lifecycle.stop();
  const result = await running;
  expect(result.cancelled).toBe(true);
  expect(result.interrupted).toBe(false);
  expect(result.agentExited).toBe(true);
  expect(alive(result.pid)).toBe(false);
  expect(result.checkpoint).toBeUndefined();
  await expect(lifecycle.prompt(options)).rejects.toThrow("ACP conversation stopped");
});

test("an already interrupted prompt does not start an agent", async () => {
  const controller = new AbortController();
  controller.abort(FOLLOW_UP_INTERRUPTION);
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-never-started",
    prompt: "Do nothing.",
    worktreePath: "/does-not-exist",
    pawsRoot: "/does-not-exist",
    signal: controller.signal,
  });
  expect(result.interrupted).toBe(true);
  expect(result.agentExited).toBe(true);
  expect(result.pid).toBeUndefined();
  expect(result.checkpoint).toBeUndefined();
});

test("follow-up interrupts initialization without waiting for an agent response", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, { hangInitialize: true, steps: [] });
  const controller = new AbortController();
  const events: AcpEvent[] = [];
  const running = runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-interrupt-initialize",
    prompt: "Wait.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    cancelGraceMs: 75,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
    },
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const trace = await readResult(files.resultPath).catch(() => undefined);
    if (trace?.methods.includes("initialize")) break;
    await Bun.sleep(10);
  }
  expect((await readResult(files.resultPath)).methods).toContain("initialize");
  controller.abort(FOLLOW_UP_INTERRUPTION);
  const result = await running;
  expect(result.interrupted).toBe(true);
  expect(result.agentExited).toBe(true);
  expect(alive(result.pid)).toBe(false);
  expect(result.errorMessage).toBeUndefined();
  expect(events).toEqual([{ type: "cancelled", reason: FOLLOW_UP_INTERRUPTION }]);
});

test("grok authenticates with cached_token, scrubs the key, and denies a path outside the worktree", async () => {
  const layout = await layoutRepo();
  await writeGrokConfig(layout.pawsRoot, false);
  const outside = join(layout.home, ".ssh", "id_rsa");
  const script: FakeScript = {
    authMethods: [{ id: "cached_token", name: "Cached login" }],
    steps: [
      {
        type: "permission",
        toolCall: {
          toolCallId: "outside",
          title: "read ssh",
          kind: "read",
          locations: [{ path: outside }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "inside",
          title: "edit readme",
          kind: "edit",
          locations: [{ path: join(layout.worktree, "README.md") }],
        },
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
  const files = await writeScript(layout.root, script);
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-grok",
    prompt: "edit the readme",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: [...fakeAgentArgs(files), ...GROK_AGENT_ARGS],
    env: {
      ...agentEnv(),
      XAI_API_KEY: "xai-should-not-leak",
      AWS_SECRET_ACCESS_KEY: "aws-should-not-leak",
    },
    onEvent: () => undefined,
  });
  expect(result.acpStopReason).toBe("end_turn");
  const trace = await readResult(files.resultPath);
  expect(trace.argv).toEqual([...GROK_AGENT_ARGS]);
  expect(trace.cwd).toBe(layout.worktree);
  expect(trace.authenticate).toEqual({ methodId: "cached_token" });
  expect(trace.methods).toEqual(["initialize", "authenticate", "session/new", "session/prompt"]);
  expect(trace.env).toEqual({
    xaiApiKey: false,
    ghToken: false,
    sshAuthSock: false,
    aws: false,
  });
  expect(JSON.stringify(trace)).not.toContain("xai-should-not-leak");
  expect(JSON.stringify(trace)).not.toContain("aws-should-not-leak");
  expect(outcome(trace, "outside")).toBe("deny");
  expect(outcome(trace, "inside")).toBe("allow");
  expect(trace.argv?.join(" ")).not.toContain("yolo");
  expect(trace.argv?.join(" ")).not.toContain("always-approve");
});

test("grok passes XAI_API_KEY only when allow_api_key is set and authenticates with that method", async () => {
  const layout = await layoutRepo();
  await writeGrokConfig(layout.pawsRoot, true);
  const script: FakeScript = {
    authMethods: [
      { id: "cached_token", name: "Cached login" },
      { id: "xai.api_key", name: "API key" },
    ],
    steps: [{ type: "end", stopReason: "end_turn" }],
  };
  const files = await writeScript(layout.root, script);
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-grok-key",
    prompt: "hi",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: {
      ...agentEnv(),
      XAI_API_KEY: "xai-allowed",
      GH_TOKEN: "gh-no",
    },
    checkpoint: false,
    onEvent: () => undefined,
  });
  expect(result.acpStopReason).toBe("end_turn");
  const trace = await readResult(files.resultPath);
  expect(trace.authenticate).toEqual({ methodId: "xai.api_key" });
  expect(trace.env?.xaiApiKey).toBe(true);
  expect(trace.env?.ghToken).toBe(false);
  expect(JSON.stringify(trace)).not.toContain("xai-allowed");
  expect(JSON.stringify(trace)).not.toContain("gh-no");
});

test("grok with no auth method posts the login line and does not hang", async () => {
  const layout = await layoutRepo();
  await writeGrokConfig(layout.pawsRoot, false);
  const events: AcpEvent[] = [];
  const script: FakeScript = { authMethods: [], steps: [{ type: "hang" }] };
  const files = await writeScript(layout.root, script);
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-grok-login",
    prompt: "hi",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    timeoutMs: 5_000,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(result.authRequired).toBe(true);
  expect(result.errorMessage).toBe(GROK_LOGIN_MESSAGE);
  expect(
    events.some((event) => event.type === "error" && event.message === GROK_LOGIN_MESSAGE),
  ).toBe(true);
  expect(events.some((event) => event.type === "session_started")).toBe(false);
  const trace = await readResult(files.resultPath);
  expect(trace.methods).toEqual(["initialize"]);
  expect(trace.authenticate).toBeUndefined();
});

test("grok is not spawned with --yolo", async () => {
  const layout = await layoutRepo();
  await writeGrokConfig(layout.pawsRoot, false);
  await expect(
    runAgent({
      role: "implementer",
      itemId: "ENG-1",
      runId: "run-yolo",
      prompt: "hi",
      worktreePath: layout.worktree,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      command: process.execPath,
      args: [fakeAgent, "--yolo"],
      env: process.env,
    }),
  ).rejects.toThrow(/--yolo/);
});

test("cancel still stops a grok session", async () => {
  const layout = await layoutRepo();
  await writeGrokConfig(layout.pawsRoot, false);
  const script: FakeScript = {
    authMethods: [{ id: "cached_token", name: "Cached login" }],
    steps: [{ type: "hang" }],
  };
  const files = await writeScript(layout.root, script);
  const controller = new AbortController();
  const running = runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-grok-cancel",
    prompt: "stop me",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: [...fakeAgentArgs(files), ...GROK_AGENT_ARGS],
    env: agentEnv(),
    timeoutMs: 10_000,
    cancelGraceMs: 1_000,
    signal: controller.signal,
    checkpoint: false,
  });
  setTimeout(() => controller.abort(), 200);
  const result = await running;
  expect(result.cancelled).toBe(true);
  expect(result.agentExited).toBe(true);
  const trace = await readResult(files.resultPath);
  expect(trace.methods).toContain("session/cancel");
  expect(trace.argv?.join(" ")).not.toContain("yolo");
  expect(trace.argv?.join(" ")).not.toContain("always-approve");
}, 20_000);

function alive(pid: number | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function outcome(trace: FakeResult, toolCallId: string): string | undefined {
  const entry = trace.permissions.find((permission) => permission.toolCallId === toolCallId);
  const outcomeValue = entry?.outcome as
    | { outcome?: { outcome?: string; optionId?: string } }
    | undefined;
  return outcomeValue?.outcome?.optionId;
}

async function layoutRepo(): Promise<{
  root: string;
  source: string;
  home: string;
  pawsRoot: string;
  worktree: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "paws-acp-"));
  roots.push(root);
  const source = join(root, "checkout");
  const home = join(root, "home");
  const pawsRoot = join(home, ".paws");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(join(home, ".config", "gh"), { recursive: true });
  await mkdir(join(home, "Library", "Keychains"), { recursive: true });
  await mkdir(source, { recursive: true });
  await git(["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "hello\n");
  await git(["-C", source, "add", "README.md"]);
  await git([
    "-C",
    source,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "init",
  ]);
  const { ensureBareMirror, createWorktree } = await import("./worktree");
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot });
  const worktree = await createWorktree({ owner: "acme", repo: "demo", itemId: "ENG-1", pawsRoot });
  return { root, source, home, pawsRoot, worktree: worktree.path };
}

async function writeGrokConfig(pawsRoot: string, allowApiKey: boolean): Promise<void> {
  await writeFile(
    join(pawsRoot, "config.toml"),
    `[agents]\nimplementer = "grok"\n\n[agents.grok]\nallow_api_key = ${allowApiKey}\n`,
  );
}

async function writeScript(
  root: string,
  script: FakeScript,
): Promise<{ scriptPath: string; resultPath: string }> {
  const scriptPath = join(root, "fake-script.json");
  const resultPath = join(root, "fake-result.json");
  await writeFile(scriptPath, JSON.stringify(script));
  return { scriptPath, resultPath };
}

function fakeAgentArgs(files: { resultPath: string; scriptPath: string }): string[] {
  return [fakeAgent, files.resultPath, files.scriptPath];
}

function agentEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_TOKEN: "should-not-pass",
    SSH_AUTH_SOCK: "/tmp/agent-sock",
  };
}

async function readResult(path: string): Promise<FakeResult> {
  return JSON.parse(await readFile(path, "utf8")) as FakeResult;
}
