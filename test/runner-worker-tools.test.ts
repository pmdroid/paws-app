import { expect, test } from "bun:test";
import { RunnerEventSchema } from "../src/runner-protocol";
import { commandRepositories, commandTools, remoteTools } from "../src/runner-worker";

const definitions = [{ name: "linear_issue", description: "Read an issue.", inputSchema: {} }];

test("a defined tool emits one event per call and resolves with Paws' answer", async () => {
  const emitted: ({ requestId: string } & Record<string, unknown>)[] = [];
  const answers = [
    JSON.stringify({ text: "PAS-1: Fix rounding" }),
    JSON.stringify({ text: "That tool is not available.", isError: true }),
  ];
  const tools = remoteTools(
    definitions,
    (event) => emitted.push(event),
    async () => ({ answer: answers.shift()! }),
    new AbortController().signal,
  );
  expect(await tools.call("linear_issue", { id: "PAS-1" })).toEqual({
    text: "PAS-1: Fix rounding",
  });
  expect(await tools.call("linear_issue", { id: "PAS-2" })).toEqual({
    text: "That tool is not available.",
    isError: true,
  });
  expect(emitted).toEqual([
    {
      type: "tool",
      requestId: expect.any(String),
      name: "linear_issue",
      arguments: { id: "PAS-1" },
    },
    {
      type: "tool",
      requestId: expect.any(String),
      name: "linear_issue",
      arguments: { id: "PAS-2" },
    },
  ]);
  for (const { requestId: _requestId, ...event } of emitted)
    expect(RunnerEventSchema.parse(event)).toEqual(
      event as ReturnType<typeof RunnerEventSchema.parse>,
    );
});

test("oversized arguments and the 201st call return an error and emit nothing", async () => {
  let emitted = 0;
  const tools = remoteTools(
    definitions,
    () => emitted++,
    async () => ({ answer: JSON.stringify({ text: "ok" }) }),
    new AbortController().signal,
  );
  expect(await tools.call("linear_issue", { text: "x".repeat(16_384) })).toMatchObject({
    isError: true,
  });
  expect(await tools.call("linear_comment", {})).toMatchObject({ isError: true });
  for (const args of [[1, 2], "text", 3, null])
    expect(
      await tools.call("linear_issue", args as unknown as Record<string, unknown>),
    ).toMatchObject({ isError: true });
  expect(emitted).toBe(0);
  for (let i = 0; i < 200; i++)
    expect(await tools.call("linear_issue", {})).toEqual({ text: "ok" });
  expect(emitted).toBe(200);
  expect(await tools.call("linear_issue", {})).toMatchObject({ isError: true });
  expect(emitted).toBe(200);
});

test("a Slack reply helper's tools reach the agent, up to 64 calls", async () => {
  const base = {
    id: "01K00000000000000000000000",
    type: "helper" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 0,
    expiresAt: 1,
    sessionId: "session",
    sessionGeneration: 1,
    profile: { agent: "claude" as const, model: null },
    prompt: "Which issue covers checkout?",
    tools: definitions,
  };
  let emitted = 0;
  const answer = async () => ({ answer: JSON.stringify({ text: "ok" }) });
  const { hostTools } = commandTools(
    { ...base, purpose: "slack_reply" },
    () => emitted++,
    answer,
    undefined,
  );
  expect(hostTools?.definitions).toEqual(definitions);
  for (let i = 0; i < 64; i++)
    expect(await hostTools!.call("linear_issue", {})).toEqual({ text: "ok" });
  expect(await hostTools!.call("linear_issue", {})).toMatchObject({ isError: true });
  expect(emitted).toBe(64);
  expect(commandTools({ ...base, purpose: "classify" }, () => {}, answer, undefined)).toEqual({});
  expect(
    commandTools(
      { ...base, purpose: "slack_reply", tools: undefined },
      () => {},
      answer,
      undefined,
    ),
  ).toEqual({});
});

test("add_repository copies Paws' snapshot into the folder and refuses a sixth repository", async () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "paws-add-repository-"));
  try {
    const commit = "c".repeat(40);
    const snapshot = (name: string) => {
      const path = join(root, "spool", name, commit);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "README.md"), `${name}\n`);
      return { repository: name, commit, path };
    };
    const published = [snapshot("acme/app"), snapshot("acme/lib")];
    const worktree = join(root, "work");
    mkdirSync(worktree);
    const emitted: { requestId: string; repository: string }[] = [];
    const command = {
      id: "01K00000000000000000000000",
      type: "helper" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: 0,
      expiresAt: 1,
      sessionId: "session",
      sessionGeneration: 1,
      profile: { agent: "claude" as const, model: null },
      prompt: "How does checkout round totals?",
      purpose: "slack_reply" as const,
      repositories: ["acme/app"],
    };
    const answers: Record<string, unknown> = {
      "acme/lib": { path: published[1]!.path, commit },
      "acme/forged": { path: published[1]!.path, commit },
    };
    const tool = commandRepositories(
      command,
      (event) => emitted.push(event),
      async (requestId) => {
        const name = emitted.find((event) => event.requestId === requestId)!.repository;
        return {
          answer: JSON.stringify(answers[name] ?? { error: `Paws could not add ${name}.` }),
        };
      },
      undefined,
      worktree,
      () => published,
    );
    tool.preload();
    expect(readFileSync(join(worktree, "repositories/acme/app/README.md"), "utf8")).toBe(
      "acme/app\n",
    );
    const add = tool.addRepository!;
    expect(await add("acme/app")).toEqual({
      text: `Added at repositories/acme/app (commit ${commit}).`,
    });
    expect(await add("acme/lib")).toEqual({
      text: `Added at repositories/acme/lib (commit ${commit}).`,
    });
    expect(readFileSync(join(worktree, "repositories/acme/lib/README.md"), "utf8")).toBe(
      "acme/lib\n",
    );
    const refused = (name: string) => ({ text: `Paws could not add ${name}.`, isError: true });
    expect(await add("acme/forged")).toEqual(refused("acme/forged"));
    expect(await add("acme/third")).toEqual(refused("acme/third"));
    expect(await add("acme/fourth")).toEqual(refused("acme/fourth"));
    expect(await add("acme/sixth")).toEqual(refused("acme/sixth"));
    expect(await add("../etc")).toMatchObject({ isError: true });
    expect(emitted.map((event) => event.repository)).toEqual([
      "acme/lib",
      "acme/forged",
      "acme/third",
      "acme/fourth",
    ]);
    for (const { requestId: _requestId, ...event } of emitted)
      expect(RunnerEventSchema.parse(event)).toEqual(event as never);
    const { repositories: _repositories, ...plain } = command;
    expect(
      commandRepositories(
        plain,
        () => {},
        async () => ({ answer: "{}" }),
        undefined,
        worktree,
        () => published,
      ).addRepository,
    ).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run with addRepositories copies read-only repositories beside its checkout", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "paws-run-add-repository-"));
  try {
    const commit = "d".repeat(40);
    const snapshot = (name: string) => {
      const path = join(root, "spool", name, commit);
      mkdirSync(join(path, "src"), { recursive: true });
      writeFileSync(join(path, "src", "index.ts"), `${name}\n`);
      return { repository: name, commit, path };
    };
    const names = ["acme/one", "acme/two", "acme/three", "acme/four", "acme/five", "acme/six"];
    const published = names.map(snapshot);
    const checkout = join(root, "work", "run");
    mkdirSync(checkout, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    git("init", "-q");
    const before = git("status", "--porcelain");
    const runRoot = join(root, "work", ".paws", "runs", "execution");
    const emitted: { requestId: string; repository: string }[] = [];
    const command = {
      id: "01K00000000000000000000000",
      type: "run" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      runId: "run",
      itemId: "item",
      generation: 1,
      issuedAt: 0,
      expiresAt: 1,
      repository: {
        owner: "acme",
        repo: "app",
        remoteUrl: "https://github.com/acme/app.git",
        baseSha: "a".repeat(40),
      },
      profile: { agent: "claude" as const, model: null },
      prompt: "Implement the issue",
      addRepositories: true,
    };
    const tool = commandRepositories(
      command,
      (event) => emitted.push(event),
      async (requestId) => {
        const name = emitted.find((event) => event.requestId === requestId)!.repository;
        const added = published.find((entry) => entry.repository === name)!;
        return { answer: JSON.stringify({ path: added.path, commit }) };
      },
      undefined,
      runRoot,
      () => published,
    );
    tool.preload();
    const add = tool.addRepository!;
    for (const name of names.slice(0, 5))
      expect(await add(name)).toEqual({
        text: `Added at ${join(runRoot, "repositories", name)} (commit ${commit}).`,
      });
    expect(await add("acme/six")).toEqual({ text: "Paws could not add acme/six.", isError: true });
    const copy = join(runRoot, "repositories", "acme", "one");
    expect(readFileSync(join(copy, "src", "index.ts"), "utf8")).toBe("acme/one\n");
    for (const path of [copy, join(copy, "src"), join(copy, "src", "index.ts")])
      expect(statSync(path).mode & 0o222).toBe(0);
    expect(readdirSync(copy)).toEqual(["src"]);
    expect(git("status", "--porcelain")).toBe(before);
    const { addRepositories: _addRepositories, ...plain } = command;
    expect(
      commandRepositories(
        plain,
        () => {},
        async () => ({ answer: "{}" }),
        undefined,
        runRoot,
        () => published,
      ).addRepository,
    ).toBeUndefined();
  } finally {
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  }
});
