import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { GROK_AGENT_ARGS, GROK_LOGIN_MESSAGE } from "./adapters";
import { git } from "./git";
import * as gitCommands from "./git";
import { minimalAgentEnv } from "./env";
import { executeItem } from "./executor";
import { probeAgentProfile } from "./probe";
import { checkOwnLogin, runAgent } from "./run";
import { createUpdateLimiter } from "./ask-team";
import { createAcpPromptLifecycle } from "./lifecycle";
import type { ArtifactSnapshot, PublishArtifactContext } from "./artifacts";
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

test.each([
  { options: ["yes", "no"] },
  {
    options: [
      { label: "Include archived", value: "yes" },
      { label: "Exclude archived", value: "no" },
    ],
  },
])("ask_team preserves choices through the injected MCP tool: %j", async ({ options }) => {
  const layout = await layoutRepo();
  const script: FakeScript = {
    steps: [{ type: "ask_team", question: "Include archived rows?", options }],
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
        expect(request.options).toEqual(options);
        return { answer: "yes" };
      },
    },
    onEvent: () => undefined,
  });
  expect(result.acpStopReason).toBe("end_turn");
  const trace = await readResult(files.resultPath);
  expect(trace.askTeam).toEqual({ ok: true, text: "yes" });
  expect(trace.tools).toEqual(["ask_team", "get_closeout", "run_closeout"]);
  expect(trace.mcpServers[0]?.name).toBe("paws");
  expect(trace.methods).not.toContain("authenticate");
});

for (const capability of ["image", "embeddedContext", "fallback"] as const) {
  test(`agent input files use negotiated ${capability} prompt content`, async () => {
    const layout = await layoutRepo();
    const inputPath = join(layout.worktree, "input.png");
    await writeFile(inputPath, "image bytes");
    const files = await writeScript(layout.root, {
      promptCapabilities:
        capability === "image"
          ? { image: true }
          : capability === "embeddedContext"
            ? { embeddedContext: true }
            : {},
      steps: [{ type: "end" }],
    });
    const result = await runAgent({
      role: "implementer",
      itemId: "ENG-1",
      runId: `input-${capability}`,
      prompt: "Describe the input.",
      worktreePath: layout.worktree,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      command: process.execPath,
      args: fakeAgentArgs(files),
      env: agentEnv(),
      checkpoint: false,
      inputFiles: [
        { path: inputPath, mimeType: "image/png", bytes: new TextEncoder().encode("image bytes") },
      ],
    });
    expect(result.stopReason).toBe("end_turn");
    const trace = await readResult(files.resultPath);
    const prompt = trace.prompts?.[0] as Array<Record<string, unknown>>;
    expect(prompt[0]).toEqual({ type: "text", text: "Describe the input." });
    expect(prompt[1]).toEqual({ type: "text", text: "Input file: ./input.png (image/png)" });
    expect(prompt).toHaveLength(capability === "fallback" ? 2 : 3);
    if (capability === "image")
      expect(prompt[2]).toMatchObject({
        type: "image",
        data: Buffer.from("image bytes").toString("base64"),
        mimeType: "image/png",
      });
    if (capability === "embeddedContext")
      expect(prompt[2]).toMatchObject({
        type: "resource",
        resource: { blob: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" },
      });
    expect(JSON.stringify(prompt)).not.toContain("uploads.linear.app");
  });
}

test("publish_artifact publishes a snapshot through MCP without an ask_team hook", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [
      { type: "fs_write", path: join(layout.worktree, "shot.png"), content: "image bytes" },
      { type: "publish_artifact", path: "shot.png", displayName: "shot[1].png" },
      { type: "end" },
    ],
  });
  let received: ArtifactSnapshot | undefined;
  let context: PublishArtifactContext | undefined;
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-artifact",
    prompt: "Return a screenshot.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    publishArtifact: {
      publish: async (artifact, input) => {
        received = artifact;
        context = input;
        await writeFile(join(layout.worktree, "shot.png"), "changed after snapshot");
        return { url: "https://uploads.example/asset.png" };
      },
    },
  });
  expect(result.stopReason).toBe("end_turn");
  expect(await received?.bytes.text()).toBe("image bytes");
  expect(received?.mimeType).toBe("image/png");
  expect(context?.itemId).toBe("ENG-1");
  expect(context?.runId).toBe("run-artifact");
  expect(context?.worktreePath).toBe(layout.worktree);
  expect(context?.role).toBe("implementer");
  const trace = await readResult(files.resultPath);
  expect(trace.tools).toEqual(["publish_artifact", "get_closeout", "run_closeout"]);
  expect(trace.artifact).toEqual({
    ok: true,
    text: "![shot\\[1\\].png](<https://uploads.example/asset.png>)",
  });
});

test.each([
  { path: ".env", maxBytes: 10, message: "secrets or credentials" },
  { path: "report.txt", maxBytes: 4, message: "exceeds 4 bytes" },
])("publish_artifact rejects $path before invoking the host upload hook", async (input) => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [
      { type: "fs_write", path: join(layout.worktree, input.path), content: "12345" },
      { type: "publish_artifact", path: input.path },
      { type: "end" },
    ],
  });
  let uploads = 0;
  await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-denied-artifact",
    prompt: "Publish a file.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    artifactLimits: { maxBytes: input.maxBytes },
    publishArtifact: {
      publish: async () => {
        uploads += 1;
        return { url: "https://uploads.example/asset" };
      },
    },
  });
  expect(uploads).toBe(0);
  expect((await readResult(files.resultPath)).artifact?.error).toContain(input.message);
});

test.each(["hook failure", "signed URL"])(
  "publish_artifact hides credentials from %s",
  async (mode) => {
    const layout = await layoutRepo();
    const files = await writeScript(layout.root, {
      steps: [
        { type: "fs_write", path: join(layout.worktree, "report.txt"), content: "report" },
        { type: "publish_artifact", path: "report.txt" },
        { type: "end" },
      ],
    });
    await runAgent({
      role: "implementer",
      itemId: "ENG-1",
      runId: "run-private-upload-error",
      prompt: "Publish a file.",
      worktreePath: layout.worktree,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      command: process.execPath,
      args: fakeAgentArgs(files),
      env: agentEnv(),
      checkpoint: false,
      publishArtifact: {
        publish: async () => {
          if (mode === "hook failure") throw new Error("upload failed: bearer secret-token");
          return { url: "https://uploads.example/upload?token=secret-token" };
        },
      },
    });
    const error = (await readResult(files.resultPath)).artifact?.error;
    expect(error).toContain(mode === "hook failure" ? "upload failed" : "invalid asset URL");
    expect(error).not.toContain("secret-token");
    expect(error).not.toContain("https://uploads.example/upload");
  },
);

for (const leftover of [true, false]) {
  test(`the agent's commits stand and Paws ${leftover ? "saves only leftovers" : "adds no commit"}`, async () => {
    const layout = await layoutRepo();
    const commit = (args: string[]) => ({
      type: "terminal" as const,
      command: "git",
      args: ["-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", ...args],
      cwd: layout.worktree,
    });
    const files = await writeScript(layout.root, {
      steps: [
        { type: "fs_write", path: join(layout.worktree, "a.txt"), content: "a\n" },
        commit(["add", "a.txt"]),
        commit(["commit", "-m", "Add a.txt"]),
        ...(leftover
          ? [{ type: "fs_write" as const, path: join(layout.worktree, "b.txt"), content: "b\n" }]
          : []),
        { type: "end" },
      ],
    });
    await runAgent({
      role: "implementer",
      itemId: "ENG-1",
      runId: "run-commits",
      prompt: "Commit your work.",
      worktreePath: layout.worktree,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      command: process.execPath,
      args: fakeAgentArgs(files),
      env: agentEnv(),
    });
    const subjects = (await git(["-C", layout.worktree, "log", "--format=%s", "-2"]))
      .trim()
      .split("\n");
    expect(subjects).toEqual(
      leftover
        ? ["Save changes the agent left uncommitted (the agent finished)", "Add a.txt"]
        : ["Add a.txt", subjects[1]!],
    );
  });
}

test("update_plan replaces the working checklist through the host tool", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [
      {
        type: "update_plan",
        steps: [
          { content: " Read the export ", status: "completed" },
          { content: "Write the parser", status: "in_progress" },
        ],
      },
      { type: "end" },
    ],
  });
  const plans: unknown[] = [];
  await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-plan",
    prompt: "Set the plan.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    updatePlan: {
      update: async (steps) => {
        plans.push(steps);
      },
    },
  });
  const trace = await readResult(files.resultPath);
  expect(trace.tools).toEqual(["update_plan", "get_closeout", "run_closeout"]);
  expect(trace.plan).toEqual({ ok: true, text: "Plan updated." });
  expect(plans).toEqual([
    [
      { content: "Read the export", status: "completed" },
      { content: "Write the parser", status: "inProgress" },
    ],
  ]);
});

test("update_plan rejects an empty checklist before calling the hook", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [{ type: "update_plan", steps: [] }, { type: "end" }],
  });
  let called = false;
  await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-plan-empty",
    prompt: "Set the plan.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    updatePlan: {
      update: async () => {
        called = true;
      },
    },
  });
  const trace = await readResult(files.resultPath);
  expect(trace.plan?.ok).toBe(false);
  expect(trace.plan?.error).toContain("1 to 16 steps");
  expect(called).toBe(false);
});

test("post_update posts once and answers a second call within a minute with the wait", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [
      { type: "post_update", text: "  Found the cause: the cache key ignores the locale.  " },
      { type: "post_update", text: "Tests pass." },
      { type: "post_update", text: "" },
      { type: "end" },
    ],
  });
  const limiter = createUpdateLimiter(() => 1_000);
  const posted: string[] = [];
  await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-update",
    prompt: "Post an update.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    postUpdate: {
      post: async (text) => {
        const allowed = limiter.take("ENG-1");
        if (allowed.posted) posted.push(text);
        return allowed;
      },
    },
  });
  const trace = await readResult(files.resultPath);
  expect(trace.tools).toEqual(["post_update", "get_closeout", "run_closeout"]);
  expect(trace.updates).toEqual([
    { ok: true, text: "Posted." },
    { ok: true, text: "Too soon. The next update is allowed in 60 seconds." },
    { ok: false, error: "post_update needs text of 1 to 500 characters" },
  ]);
  expect(posted).toEqual(["Found the cause: the cache key ignores the locale."]);
});

test("the update limiter allows one update per key per minute", () => {
  let now = 0;
  const limiter = createUpdateLimiter(() => now);
  expect(limiter.take("a")).toEqual({ posted: true });
  now = 15_500;
  expect(limiter.take("a")).toEqual({ posted: false, waitSeconds: 45 });
  expect(limiter.take("b")).toEqual({ posted: true });
  now = 59_999;
  expect(limiter.take("a")).toEqual({ posted: false, waitSeconds: 1 });
  now = 60_000;
  expect(limiter.take("a")).toEqual({ posted: true });
});

test("ask_team and publish_artifact share one MCP server", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [
      { type: "fs_write", path: join(layout.worktree, "report.txt"), content: "report" },
      { type: "ask_team", question: "Publish the report?" },
      { type: "publish_artifact", path: "report.txt" },
      { type: "end" },
    ],
  });
  await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-both-tools",
    prompt: "Ask and then publish.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    askTeam: { ask: async () => ({ answer: "yes" }) },
    publishArtifact: { publish: async () => ({ url: "https://uploads.example/report.txt" }) },
  });
  const trace = await readResult(files.resultPath);
  expect(trace.mcpServers).toHaveLength(1);
  expect(trace.tools).toEqual(["ask_team", "publish_artifact", "get_closeout", "run_closeout"]);
  expect(trace.askTeam?.text).toBe("yes");
  expect(trace.artifact?.ok).toBe(true);
});

test("get_closeout lists the pending check and run_closeout runs it", async () => {
  const layout = await layoutRepo();
  await mkdir(join(layout.worktree, ".agents"), { recursive: true });
  await writeFile(
    join(layout.worktree, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: check",
      "    kind: command",
      "    gate: beforePR",
      '    exec: ["true"]',
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
  const files = await writeScript(layout.root, {
    steps: [
      { type: "get_closeout" },
      { type: "run_closeout", id: "check" },
      { type: "get_closeout" },
      { type: "end" },
    ],
  });
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-closeout-tool",
    prompt: "Verify the change.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    updatePlan: { update: async () => undefined },
  });
  const trace = await readResult(files.resultPath);
  expect(trace.tools).toEqual(["update_plan", "get_closeout", "run_closeout"]);
  const first = JSON.parse(trace.closeouts?.[0] ?? "{}") as { pending?: string[] };
  const second = JSON.parse(trace.closeouts?.[2] ?? "{}") as {
    pending?: string[];
    required?: Array<{ id: string; status: string }>;
  };
  expect(first.pending).toEqual(["check"]);
  expect(trace.closeouts?.[1]).toBe("check passed.");
  expect(second.pending).toEqual([]);
  expect(second.required?.find((item) => item.id === "check")?.status).toBe("passed");
  expect(JSON.parse(result.closeoutReport ?? "null")).toMatchObject({
    pending: [],
    blocked: null,
  });
  expect(result.closeoutRuns).toEqual([
    expect.objectContaining({ id: "check", argv: ["true"], exitCode: 0, timedOut: false }),
  ]);
});

test("a read-only session lists get_closeout and not run_closeout", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [{ type: "get_closeout" }, { type: "end" }],
  });
  await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-closeout-readonly",
    prompt: "Answer.",
    readOnly: true,
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    askTeam: { ask: async () => ({ answer: "yes" }) },
  });
  const trace = await readResult(files.resultPath);
  expect(trace.tools).toEqual(["ask_team", "get_closeout"]);
});

test("run_closeout refuses a command the terminal guard denies", async () => {
  const layout = await layoutRepo();
  const secret = join(layout.home, ".ssh", "id_rsa");
  await writeFile(secret, "secret-key\n");
  await mkdir(join(layout.worktree, ".agents"), { recursive: true });
  await writeFile(
    join(layout.worktree, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: leak",
      "    kind: command",
      "    gate: beforePR",
      `    exec: ${JSON.stringify(["cat", secret])}`,
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
  const files = await writeScript(layout.root, {
    steps: [
      { type: "get_closeout" },
      { type: "run_closeout", id: "leak" },
      { type: "get_closeout" },
      { type: "end" },
    ],
  });
  await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-closeout-denied",
    prompt: "Verify the change.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    updatePlan: { update: async () => undefined },
  });
  const trace = await readResult(files.resultPath);
  expect(trace.closeouts?.[1]).toContain("path is under ~/.ssh");
  expect(trace.closeouts?.join("\n")).not.toContain("secret-key");
  const second = JSON.parse(trace.closeouts?.[2] ?? "{}") as {
    required?: Array<{ id: string; status: string; failed_attempts: number }>;
  };
  expect(second.required?.find((item) => item.id === "leak")).toMatchObject({
    status: "missing",
    failed_attempts: 0,
  });
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

test("a cooperative timeout returns cancelled without publishing a checkpoint", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [
      { type: "fs_write", path: join(layout.worktree, "partial.txt"), content: "partial\n" },
      { type: "hang" },
    ],
  });
  const events: AcpEvent[] = [];
  const controller = new AbortController();
  const schedule = globalThis.setTimeout;
  const watchdog = schedule(() => controller.abort(), 10_000);
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: (...args: unknown[]) => void,
    milliseconds?: number,
    ...args: unknown[]
  ) => {
    if (milliseconds === 100 && expire === undefined) {
      const scheduled = schedule(handler, 10_000, ...args);
      expire = () => {
        clearTimeout(scheduled);
        handler(...args);
      };
      return scheduled;
    }
    return schedule(handler, milliseconds, ...args);
  }) as typeof setTimeout);
  const completion = runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-cooperative-timeout",
    prompt: "Wait after writing.",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    timeoutMs: 100,
    signal: controller.signal,
    cancelGraceMs: 200,
    onEvent: (event) => {
      events.push(event);
    },
  }).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let finished = false;
  void completion.then(() => {
    finished = true;
  });
  try {
    const deadline = performance.now() + 5_000;
    while (true) {
      const trace = await readResult(files.resultPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (
        trace?.fs.some(
          (entry) =>
            entry.op === "write" && entry.path === join(layout.worktree, "partial.txt") && entry.ok,
        )
      )
        break;
      if (finished) {
        const completed = await completion;
        if (!completed.ok) throw completed.error;
        throw new Error("ACP finished before the timeout write precondition");
      }
      expect(performance.now()).toBeLessThan(deadline);
      await Bun.sleep(5);
    }
    expect(await readFile(join(layout.worktree, "partial.txt"), "utf8")).toBe("partial\n");
    expect(expire).toBeDefined();
    expire!();
    const completed = await completion;
    if (!completed.ok) throw completed.error;
    const result = completed.result;
    expect(result).toMatchObject({
      timedOut: true,
      cancelled: true,
      acpStopReason: "cancelled",
      agentExited: true,
    });
    expect(result.checkpoint).toBeUndefined();
    expect(events.some((event) => event.type === "checkpoint")).toBe(false);
    expect((await git(["-C", layout.worktree, "log", "-1", "--format=%s"])).trim()).toBe("init");
    expect(await readFile(join(layout.worktree, "partial.txt"), "utf8")).toBe("partial\n");
    expect(result.pid).toBeDefined();
    expect(alive(result.pid)).toBe(false);
  } finally {
    timer.mockRestore();
    clearTimeout(watchdog);
    controller.abort();
    await completion;
  }
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

for (const boundary of ["publication", "activity"] as const) {
  test(`a checkpoint published before follow-up ${boundary} stays completed`, async () => {
    const layout = await layoutRepo();
    const files = await writeScript(layout.root, {
      steps: [
        { type: "fs_write", path: join(layout.worktree, "complete.txt"), content: "complete\n" },
        { type: "end" },
      ],
    });
    const controller = new AbortController();
    const originalGit = gitCommands.git;
    const calls = spyOn(gitCommands, "git").mockImplementation(async (args, options) => {
      const result = await originalGit(args, options);
      if (boundary === "publication" && (args.includes("commit") || args.includes("commit-tree")))
        queueMicrotask(() => queueMicrotask(() => controller.abort(FOLLOW_UP_INTERRUPTION)));
      return result;
    });
    try {
      const result = await runAgent({
        role: "implementer",
        itemId: "ENG-1",
        runId: "run-checkpoint-publication",
        prompt: "Finish the file.",
        worktreePath: layout.worktree,
        pawsRoot: layout.pawsRoot,
        home: layout.home,
        command: process.execPath,
        args: fakeAgentArgs(files),
        env: agentEnv(),
        signal: controller.signal,
        onEvent: (event) => {
          if (boundary === "activity" && event.type === "checkpoint" && event.checkpoint.committed)
            controller.abort(FOLLOW_UP_INTERRUPTION);
        },
      });
      expect(controller.signal.aborted).toBe(true);
      expect(result.checkpoint?.committed).toBe(true);
      expect(result.cancelled).toBe(false);
      expect(result.interrupted).not.toBe(true);
      expect(result.stopReason).toBe("end_turn");
      expect((await git(["-C", layout.worktree, "rev-parse", "HEAD"])).trim()).toBe(
        result.checkpoint?.sha ?? "",
      );
    } finally {
      calls.mockRestore();
    }
  });
}

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
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "check-1",
          title: "Check partial.txt",
          kind: "execute",
          status: "in_progress",
          _meta: { terminal_output_delta: { terminal_id: "check-1", data: "File " } },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "check-1",
          status: "completed",
          _meta: { terminal_output_delta: { terminal_id: "check-1", data: "verified." } },
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
      if (
        event.type === "session_update" &&
        event.update.sessionUpdate === "tool_call_update" &&
        event.update.toolCallId === "check-1" &&
        event.update.status === "completed"
      )
        ready();
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
  expect(prompt).toContain("File verified.");
  expect(prompt).not.toContain("private reasoning");
  expect(lifecycle.snapshot().filter((entry) => entry.kind === "tool_result")).toHaveLength(2);
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

test("ACP selects the advertised model and returns real session identity", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    sessionId: "observed-session",
    model: "gpt-model-a",
    models: ["gpt-model-a", "gpt-model-b"],
    steps: [{ type: "end" }],
  });
  const result = await runAgent({
    role: "reviewer",
    profile: { agent: "codex", model: "gpt-model-b" },
    itemId: "ENG-1",
    runId: "model-selection",
    prompt: "review",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
    checkpoint: false,
  });
  expect(result.identity).toEqual({
    session: "observed-session",
    model: "gpt-model-b",
    provider: "openai",
  });
  expect((await readResult(files.resultPath)).modelSelection).toEqual({
    sessionId: "observed-session",
    configId: "model",
    value: "gpt-model-b",
  });
});

for (const recommendation of ["Sonnet 5.5", "claude-sonnet-5-5"]) {
  test(`ACP confirms the concrete default model described as ${recommendation} before preflight`, async () => {
    const layout = await layoutRepo();
    const files = await writeScript(layout.root, {
      model: "default",
      modelOptions: [
        { value: "default", name: "Default (recommended)", description: recommendation },
        { value: "claude-sonnet-5-5", name: "Sonnet 5.5" },
        { value: "claude-opus-5-5", name: "Opus 5.5" },
      ],
      steps: [{ type: "end" }],
    });
    const result = await runAgent({
      role: "implementer",
      profile: { agent: "claude", model: null },
      itemId: "ENG-1",
      runId: "default-model-preflight",
      prompt: "",
      prepareOnly: true,
      checkpoint: false,
      worktreePath: layout.worktree,
      pawsRoot: layout.pawsRoot,
      command: process.execPath,
      args: fakeAgentArgs(files),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.identity?.model).toBe("claude-sonnet-5-5");
    const trace = await readResult(files.resultPath);
    expect(trace.modelSelection).toEqual({
      sessionId: result.sessionId,
      configId: "model",
      value: "claude-sonnet-5-5",
    });
    expect(trace.methods).toEqual(["initialize", "session/new", "session/set_config_option"]);
  });
}

for (const failure of ["missing", "unknown", "ambiguous", "rejected", "unconfirmed"]) {
  test(`ACP does not invent a model for a ${failure} default recommendation`, async () => {
    const layout = await layoutRepo();
    const files = await writeScript(layout.root, {
      model: "default",
      modelOptions: [
        {
          value: "default",
          name: "Default (recommended)",
          ...(failure === "missing"
            ? {}
            : { description: failure === "unknown" ? "Unknown" : "Sonnet 5.5" }),
        },
        { value: "claude-sonnet-5-5", name: "Sonnet 5.5" },
        { value: "other-model", name: failure === "ambiguous" ? "Sonnet 5.5" : "Other" },
      ],
      ...(failure === "rejected" ? { modelError: "model unavailable" } : {}),
      ...(failure === "unconfirmed" ? { confirmModel: "default" } : {}),
      steps: [{ type: "end" }],
    });
    const result = await runAgent({
      role: "implementer",
      profile: { agent: "claude", model: null },
      itemId: "ENG-1",
      runId: "invalid-default-preflight",
      prompt: "",
      prepareOnly: true,
      checkpoint: false,
      worktreePath: layout.worktree,
      pawsRoot: layout.pawsRoot,
      command: process.execPath,
      args: fakeAgentArgs(files),
    });
    expect(result.identity).toBeUndefined();
    const trace = await readResult(files.resultPath);
    expect(trace.methods).not.toContain("session/prompt");
    if (["rejected", "unconfirmed"].includes(failure)) {
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("model");
    } else expect(trace.modelSelection).toBeUndefined();
  });
}

for (const failure of ["unadvertised", "rejected", "unconfirmed"] as const) {
  test(`ACP refuses ${failure} model selection before prompting`, async () => {
    const layout = await layoutRepo();
    const files = await writeScript(layout.root, {
      model: "gpt-model-a",
      models: failure === "unadvertised" ? ["gpt-model-a"] : ["gpt-model-a", "gpt-model-b"],
      ...(failure === "rejected" ? { modelError: "model unavailable" } : {}),
      ...(failure === "unconfirmed" ? { confirmModel: "gpt-model-a" } : {}),
      steps: [{ type: "end" }],
    });
    const result = await runAgent({
      role: "implementer",
      profile: { agent: "codex", model: "gpt-model-b" },
      itemId: "ENG-1",
      runId: "bad-model",
      prompt: "implement",
      worktreePath: layout.worktree,
      pawsRoot: layout.pawsRoot,
      command: process.execPath,
      args: fakeAgentArgs(files),
      checkpoint: false,
    });
    expect(result.stopReason).toBe("error");
    expect(result.identity).toBeUndefined();
    expect((await readResult(files.resultPath)).methods).not.toContain("session/prompt");
  });
}

test("ACP selects effort from the chosen model before prompting", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    model: "model-a",
    models: ["model-a", "model-b"],
    modelEfforts: { "model-a": ["low", "medium"], "model-b": ["medium", "high"] },
    steps: [{ type: "end" }],
  });
  const result = await runAgent({
    role: "implementer",
    profile: { agent: "codex", model: "model-b", effort: "high" },
    itemId: "ENG-1",
    runId: "effort",
    prompt: "implement",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
    checkpoint: false,
  });
  expect(result.stopReason).toBe("end_turn");
  expect(result.identity?.model).toBe("model-b");
  expect(result.effort).toBe("high");
  expect(result.efforts).toEqual([
    { id: "medium", name: "medium" },
    { id: "high", name: "high" },
  ]);
  const trace = await readResult(files.resultPath);
  expect(trace.effortSelection).toEqual({
    sessionId: result.sessionId,
    configId: "reasoning_effort",
    value: "high",
  });
  expect(trace.methods.slice(-3)).toEqual([
    "session/set_config_option",
    "session/set_config_option",
    "session/prompt",
  ]);
});

for (const failure of ["unsupported", "unadvertised", "rejected", "unconfirmed"] as const) {
  test(`ACP refuses ${failure} effort selection before prompting`, async () => {
    const layout = await layoutRepo();
    const files = await writeScript(layout.root, {
      ...(failure === "unsupported"
        ? {}
        : { efforts: failure === "unadvertised" ? ["medium"] : ["medium", "high"] }),
      ...(failure === "rejected" ? { effortError: "effort unavailable" } : {}),
      ...(failure === "unconfirmed" ? { confirmEffort: "medium" } : {}),
      steps: [{ type: "end" }],
    });
    const result = await runAgent({
      role: "implementer",
      profile: { agent: "codex", model: null, effort: "high" },
      itemId: "ENG-1",
      runId: "bad-effort",
      prompt: "implement",
      worktreePath: layout.worktree,
      pawsRoot: layout.pawsRoot,
      command: process.execPath,
      args: fakeAgentArgs(files),
      checkpoint: false,
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("effort");
    expect((await readResult(files.resultPath)).methods).not.toContain("session/prompt");
  });
}

test("ACP initialization-only preflight does not run tools or prompt", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    model: "gpt-model-a",
    steps: [{ type: "fs_write", path: join(layout.worktree, "should-not-exist"), content: "bad" }],
  });
  const result = await runAgent({
    role: "reviewer",
    profile: { agent: "codex", model: null },
    itemId: "ENG-1",
    runId: "prepare",
    prompt: "",
    prepareOnly: true,
    checkpoint: false,
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
  });
  expect(result.identity?.model).toBe("gpt-model-a");
  expect((await readResult(files.resultPath)).methods).toEqual(["initialize", "session/new"]);
});

test("ACP refuses a model change during a candidate turn", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    model: "model-a",
    steps: [
      {
        type: "update",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "model-b",
              options: [{ value: "model-b", name: "B" }],
            },
          ],
        },
      },
      { type: "end" },
    ],
  });
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "changed-model",
    prompt: "implement",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
    checkpoint: false,
  });
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("changed model");
  expect(result.identity).toBeUndefined();
});

test("ACP reviewer denies writes and commands", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    steps: [
      { type: "fs_write", path: join(layout.worktree, "unsafe"), content: "bad" },
      { type: "terminal", command: "touch", args: ["unsafe"] },
      { type: "end" },
    ],
  });
  const result = await runAgent({
    role: "reviewer",
    itemId: "ENG-1",
    runId: "readonly",
    prompt: "review",
    readOnly: true,
    checkpoint: false,
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
  });
  expect(result.stopReason).toBe("end_turn");
  const trace = await readResult(files.resultPath);
  expect(trace.fs[0]?.ok).toBe(false);
  expect(trace.terminals[0]?.ok).toBe(false);
});

test("connection probe verifies the model in a disposable session", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, {
    model: "gpt-model-a",
    models: ["gpt-model-a", "gpt-model-b"],
    efforts: ["low", "medium", "high"],
    steps: [{ type: "end" }],
  });
  const prior = process.env.PAWS_CODEX_ACP;
  process.env.PAWS_CODEX_ACP = `${process.execPath} ${fakeAgent} ${files.resultPath} ${files.scriptPath}`;
  try {
    const result = await probeAgentProfile({
      profile: { agent: "codex", model: "gpt-model-b" },
      pawsRoot: layout.pawsRoot,
      worktree: layout.worktree,
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("gpt-model-b");
    expect(result.models.map((model) => model.id)).toEqual(["gpt-model-a", "gpt-model-b"]);
    expect(result.effort).toBe("medium");
    expect(result.efforts.map((effort) => effort.id)).toEqual(["low", "medium", "high"]);
    expect((await readResult(files.resultPath)).methods).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
    ]);
  } finally {
    if (prior === undefined) delete process.env.PAWS_CODEX_ACP;
    else process.env.PAWS_CODEX_ACP = prior;
  }
});

test("connection probe fails when the agent cannot identify its default model", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, { model: null, steps: [{ type: "end" }] });
  const prior = process.env.PAWS_CODEX_ACP;
  process.env.PAWS_CODEX_ACP = `${process.execPath} ${fakeAgent} ${files.resultPath} ${files.scriptPath}`;
  try {
    const result = await probeAgentProfile({
      profile: { agent: "codex", model: null },
      pawsRoot: layout.pawsRoot,
      worktree: layout.worktree,
    });
    expect(result.ok).toBe(false);
    expect(result.model).toBeNull();
    expect(result.message).toContain("model");
  } finally {
    if (prior === undefined) delete process.env.PAWS_CODEX_ACP;
    else process.env.PAWS_CODEX_ACP = prior;
  }
});

test("Claude refuses finish through a session stop hook", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, { steps: [{ type: "end" }] });
  const result = await runAgent({
    role: "implementer",
    profile: { agent: "claude", model: null },
    itemId: "ENG-1",
    runId: "claude-stop",
    prompt: "implement",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    updatePlan: { update: async () => undefined },
  });
  expect(result.stopReason).toBe("end_turn");
  const trace = await readResult(files.resultPath);
  const meta = trace.sessionMeta as {
    claudeCode: {
      options: {
        settingSources: string[];
        env: { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: string };
        settings: {
          hooks: {
            Stop: Array<{ hooks: Array<{ command: string; args: string[]; type: string }> }>;
          };
        };
      };
    };
  };
  const hook = meta.claudeCode.options.settings.hooks.Stop[0]?.hooks[0];
  const scriptPath = join(layout.pawsRoot, "runs", "claude-stop", "closeout-stop");
  expect(meta.claudeCode.options.settingSources).toEqual(["user", "project"]);
  expect(meta.claudeCode.options.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP).toBe("100");
  expect(hook).toMatchObject({ type: "command", args: [scriptPath] });
  expect(await readFile(scriptPath, "utf8")).toContain(
    join(layout.pawsRoot, "runs", "claude-stop", "ask-team.sock"),
  );
  expect(trace.codexHome).toBe(process.env.CODEX_HOME);
});

test("Claude adds no commit or pull request attribution of its own", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, { steps: [{ type: "end" }] });
  await runAgent({
    role: "implementer",
    profile: { agent: "claude", model: null },
    itemId: "ENG-1",
    runId: "claude-attribution",
    prompt: "implement",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    updatePlan: { update: async () => undefined },
  });
  const trace = await readResult(files.resultPath);
  const meta = trace.sessionMeta as {
    claudeCode: { options: { settings: { attribution: unknown } } };
  };
  expect(meta.claudeCode.options.settings.attribution).toEqual({ commit: "", pr: "" });
});

test("Codex refuses finish through a trusted stop hook in a session home", async () => {
  const layout = await layoutRepo();
  const source = join(layout.root, "codex-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "auth.json"), '{"token":"keep"}\n');
  await writeFile(join(source, "config.toml"), "[features]\nhooks = false\n");
  const files = await writeScript(layout.root, { steps: [{ type: "end" }] });
  await runAgent({
    role: "implementer",
    profile: { agent: "codex", model: null },
    itemId: "ENG-1",
    runId: "codex-stop",
    prompt: "implement",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: { ...agentEnv(), CODEX_HOME: source },
    checkpoint: false,
    updatePlan: { update: async () => undefined },
  });
  const trace = await readResult(files.resultPath);
  const overlay = join(layout.pawsRoot, "runs", "codex-stop", "codex-home");
  expect(trace.codexHome).toBe(overlay);
  expect(trace.sessionMeta).toBeUndefined();
  expect(await readlink(join(overlay, "auth.json"))).toBe(join(source, "auth.json"));
  expect(await readFile(join(source, "config.toml"), "utf8")).toContain("hooks = false");
  expect(await readFile(join(overlay, "config.toml"), "utf8")).toContain("hooks = true");
  expect(await readFile(join(source, "auth.json"), "utf8")).toBe('{"token":"keep"}\n');
});

test("a read-only session does not install a closeout stop hook", async () => {
  const layout = await layoutRepo();
  const files = await writeScript(layout.root, { steps: [{ type: "end" }] });
  const result = await runAgent({
    role: "reviewer",
    profile: { agent: "claude", model: null },
    itemId: "ENG-1",
    runId: "readonly-stop",
    prompt: "review",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: fakeAgentArgs(files),
    env: agentEnv(),
    checkpoint: false,
    readOnly: true,
    updatePlan: { update: async () => undefined },
  });
  expect(result.closeoutReport).toBeUndefined();
  const trace = await readResult(files.resultPath);
  expect(trace.sessionMeta).toBeUndefined();
  const script = join(layout.pawsRoot, "runs", "readonly-stop", "closeout-stop");
  await expect(lstat(script)).rejects.toThrow();
});

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
