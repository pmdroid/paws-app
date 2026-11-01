import { afterEach, expect, test } from "bun:test";
import {
  createFakeLivePreviewSystem,
  listeningInodes,
  startLivePreview,
} from "../src/live-preview";
import {
  RunnerEventSchema,
  RunnerLivePreviewSchema,
  type RunnerPreviewEvent,
} from "../src/runner-protocol";

const preview = { command: "bun run dev", port: 5173, path: "/items" };

function events() {
  const seen: RunnerPreviewEvent[] = [];
  return {
    seen,
    emit(event: RunnerPreviewEvent) {
      expect(RunnerEventSchema.safeParse(event).success).toBe(true);
      seen.push(event);
    },
  };
}

const saved = { ...process.env };
afterEach(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, saved);
});

test("a preview starts, reports ready at its HTTPS name and stops at the time limit", async () => {
  const system = createFakeLivePreviewSystem({ answersAfter: 2, warmAfter: 2 });
  const { seen, emit } = events();
  const started = await startLivePreview({
    preview,
    runner: "01RUNNERA",
    worktree: "/work/run",
    path: "/usr/bin:/bin",
    system,
    emit,
    timeLimitMs: 20,
  });
  expect(started?.url).toBe("https://paws-preview-01runnera-1.tail0.ts.net/items");
  expect(await started!.stopped).toBe("time_limit");
  expect(seen).toEqual([
    { type: "preview", state: "starting", service: "paws-preview-01runnera-1" },
    {
      type: "preview",
      state: "ready",
      service: "paws-preview-01runnera-1",
      url: "https://paws-preview-01runnera-1.tail0.ts.net/items",
    },
    {
      type: "preview",
      state: "stopped",
      service: "paws-preview-01runnera-1",
      reason: "time_limit",
    },
  ]);
  expect(system.spawned[0]).toMatchObject({ command: "bun run dev", cwd: "/work/run" });
  expect(system.tailscaleCalls).toEqual([
    ["status", "--json"],
    ["serve", "--service=svc:paws-preview-01runnera-1", "--https=443", "http://127.0.0.1:5173"],
    ["serve", "clear", "svc:paws-preview-01runnera-1"],
  ]);
  expect(system.killed).toEqual([4100]);
  expect(system.released).toEqual([1]);
  await started!.stop("run_ended");
  expect(seen).toHaveLength(3);
});

test("a listener the preview command did not start fails the start", async () => {
  for (const listenerPids of [[777], [4100, null], []]) {
    const system = createFakeLivePreviewSystem({ listenerPids });
    const { seen, emit } = events();
    const started = await startLivePreview({
      preview,
      runner: "01RUNNERA",
      worktree: "/work/run",
      path: "/usr/bin:/bin",
      system,
      emit,
    });
    expect(started).toBeNull();
    expect(seen.at(-1)).toMatchObject({ state: "stopped", reason: "failed" });
    expect(system.tailscaleCalls.some((call) => call[0] === "serve")).toBe(false);
    expect(system.killed).toEqual([4100]);
    expect(system.released).toEqual([1]);
  }
  const child = createFakeLivePreviewSystem({ children: [4101], listenerPids: [4101] });
  const started = await startLivePreview({
    preview,
    runner: "01RUNNERA",
    worktree: "/work/run",
    path: "/usr/bin:/bin",
    system: child,
    emit: () => {},
  });
  expect(started?.service).toBe("paws-preview-01runnera-1");
  await started!.stop("run_ended");
});

test("the preview environment has no Paws secrets or agent credentials", async () => {
  Object.assign(process.env, {
    PAWS_WORKSPACE_TOKEN: "secret",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
  });
  expect(
    RunnerLivePreviewSchema.safeParse({ ...preview, fixtures: { PAWS_TOKEN: "x" } }).success,
  ).toBe(false);
  const system = createFakeLivePreviewSystem();
  const started = await startLivePreview({
    preview: {
      ...preview,
      fixtures: { DATABASE_URL: "file:fixture.db", PAWS_SECRET: "x", OPENAI_API_KEY: "x" },
    },
    runner: "01RUNNERA",
    worktree: "/work/run",
    path: "/usr/bin:/bin",
    system,
    emit: () => {},
  });
  const env = system.spawned[0]!.env;
  expect(Object.keys(env).sort()).toEqual(["DATABASE_URL", "HOME", "HOST", "LANG", "PATH", "PORT"]);
  expect(env).toMatchObject({ DATABASE_URL: "file:fixture.db", PORT: "5173", HOST: "127.0.0.1" });
  expect(env.HOME).not.toBe(process.env.HOME);
  expect(Object.values(env)).not.toContain("secret");
  await started!.stop("run_ended");
});

test("a command that exits before the port answers fails the start", async () => {
  const system = createFakeLivePreviewSystem({ answersAfter: 1_000_000 });
  system.exit();
  const { seen, emit } = events();
  expect(
    await startLivePreview({
      preview,
      runner: "01RUNNERA",
      worktree: "/w",
      path: "/bin",
      system,
      emit,
    }),
  ).toBeNull();
  expect(seen.at(-1)).toMatchObject({ reason: "failed" });
});

test("listening sockets are read from the kernel table by port", () => {
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1",
    "   1: 0100007F:1435 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1",
    "   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4444 1",
  ].join("\n");
  expect(listeningInodes(table, 5173)).toEqual(["4242"]);
});

test("two runners name their first preview services apart", async () => {
  const services = [];
  for (const runner of ["01RUNNERA", "01RUNNERB"]) {
    const started = await startLivePreview({
      preview,
      runner,
      worktree: "/w",
      path: "/bin",
      system: createFakeLivePreviewSystem(),
      emit: () => {},
    });
    services.push(started!.service);
    await started!.stop("run_ended");
  }
  expect(services).toEqual(["paws-preview-01runnera-1", "paws-preview-01runnerb-1"]);
});

test("a run that ends while the preview starts stops it without waiting for readiness", async () => {
  const ending = new AbortController();
  let sleeps = 0;
  const system = createFakeLivePreviewSystem({
    answersAfter: 1_000_000,
    onSleep: () => void (++sleeps === 3 && ending.abort()),
  });
  const { seen, emit } = events();
  expect(
    await startLivePreview({
      preview,
      runner: "01RUNNERA",
      worktree: "/w",
      path: "/bin",
      system,
      emit,
      signal: ending.signal,
    }),
  ).toBeNull();
  expect(sleeps).toBe(3);
  expect(seen.at(-1)).toEqual({
    type: "preview",
    state: "stopped",
    service: "paws-preview-01runnera-1",
    reason: "run_ended",
  });
  expect(system.killed).toEqual([4100]);
  expect(system.released).toEqual([1]);
});
