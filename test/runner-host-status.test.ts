import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  listRunnerRuntimes,
  listRunnerSkills,
  type RunnerRuntimeStatus,
  skillRollouts,
  type RunnerSkillView,
  markSkillRemoved,
  migrate,
  openDatabase,
  putWorkspaceUser,
  saveSkill,
} from "../src/db";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createRunnerHostSampler } from "../src/runner-daemon";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { miseVersionFromOutput, releaseVersionFromPath } from "../src/runner-protocol";
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
function temporary() {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-host-"));
  roots.push(root);
  return root;
}

async function fixture() {
  const root = temporary();
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
  const client = await createRunnerKey(join(root, "client"));
  const pending = { name: "Host VM", csr: client.csr };
  const { runnerId } = await control.enroll({
    ...pending,
    token: control.createEnrollment(principal, pending).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const skillsRoot = join(root, "skills");
  const http = createRunnerWorkHttp(work, { skillsRoot });
  const browser = createRunnerHttp(control);
  return {
    db,
    runnerId,
    skillsRoot,
    fetch: (path: string) => http(new Request(`https://runner.invalid${path}`), runnerId),
    heartbeat: (body: unknown) =>
      http(
        new Request("https://runner.invalid/v1/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        runnerId,
      ),
    list: async () =>
      (await (await browser.browser(
        new Request("https://paws.invalid/api/runners"),
        principal,
      ))!.json()) as {
        runners: {
          id: string;
          hasRunWork: boolean;
          metrics: unknown;
          os: unknown;
          version: unknown;
          idle: boolean;
        }[];
        serverVersion: string | null;
      },
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

const sample = {
  cpuPercent: 37.5,
  cpuCount: 8,
  memoryTotalBytes: 8_000_000_000,
  memoryAvailableBytes: 3_000_000_000,
  load1: 0.5,
  load5: 0.75,
  load15: 1.25,
  diskTotalBytes: 100_000_000_000,
  diskFreeBytes: 40_000_000_000,
  osId: "ubuntu",
  osVersion: "24.04",
  runnerVersion: "1.4.0",
  miseVersion: "2026.10.18",
};

test("a heartbeat stores host metrics and the runner list returns them", async () => {
  const runner = await fixture();
  expect((await runner.heartbeat({ ...sample, capacity: 2 }))!.status).toBe(200);
  const listed = await runner.list();
  expect(listed.serverVersion).toBe("2.3.4");
  expect(listed.runners).toHaveLength(1);
  expect(listed.runners[0]).toMatchObject({
    id: runner.runnerId,
    metrics: {
      cpuPercent: 37.5,
      cpuCount: 8,
      memoryTotalBytes: 8_000_000_000,
      memoryAvailableBytes: 3_000_000_000,
      load1: 0.5,
      load5: 0.75,
      load15: 1.25,
      diskTotalBytes: 100_000_000_000,
      diskFreeBytes: 40_000_000_000,
      reportedAt: runner.now(),
    },
    os: { id: "ubuntu", version: "24.04" },
    version: "1.4.0",
    idle: true,
  });

  runner.advance(15_000);
  expect((await runner.heartbeat({ ...sample, cpuPercent: 5 }))!.status).toBe(200);
  const updated = (await runner.list()).runners[0]!;
  expect(updated.metrics).toMatchObject({ cpuPercent: 5, reportedAt: runner.now() });
  expect(runner.db.query("SELECT COUNT(*) AS count FROM runner_host_status").get()).toEqual({
    count: 1,
  });
  expect(
    runner.db
      .query(
        "SELECT runner_version AS runnerVersion,mise_version AS miseVersion FROM runner_host_status",
      )
      .get(),
  ).toEqual({ runnerVersion: "1.4.0", miseVersion: "2026.10.18" });
  expect((await runner.heartbeat({ runnerVersion: "1.4.0" }))!.status).toBe(200);
  expect(
    runner.db.query("SELECT mise_version AS miseVersion FROM runner_host_status").get(),
  ).toEqual({ miseVersion: null });
});

test("a heartbeat without host fields is still accepted", async () => {
  const runner = await fixture();
  expect((await runner.heartbeat({}))!.status).toBe(200);
  expect((await runner.heartbeat({ capacity: 3 }))!.status).toBe(200);
  expect((await runner.list()).runners[0]).toMatchObject({
    metrics: null,
    os: null,
    version: null,
    idle: true,
  });
});

test("out-of-range or unknown heartbeat fields are rejected", async () => {
  const runner = await fixture();
  for (const body of [
    { cpuPercent: 101 },
    { cpuCount: 0 },
    { cpuCount: 2.5 },
    { memoryTotalBytes: -1 },
    { osId: "ubuntu; rm -rf /" },
    { runnerVersion: "1.2" },
    { miseVersion: "2026.10" },
    { miseVersion: "v2026.10.18" },
    { miseVersion: "2026.10.18 linux-x64" },
    { hostname: "leak" },
  ])
    expect((await runner.heartbeat(body))!.status).toBe(403);
  expect((await runner.list()).runners[0]!.metrics).toBeNull();
});

test("a runner with a pending command or open work is not idle", async () => {
  const runner = await fixture();
  runner.db.run(
    "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES('probe-1',?,'probe','{}',?)",
    [runner.runnerId, runner.now() + 60_000],
  );
  expect((await runner.list()).runners[0]!.idle).toBe(false);
  runner.db.run("UPDATE runner_command SET acknowledged_at=? WHERE id='probe-1'", [runner.now()]);
  expect((await runner.list()).runners[0]!.idle).toBe(true);
});

test("the host sampler reads /proc, statfs, os-release and the release path", () => {
  const root = temporary();
  const proc = join(root, "proc");
  mkdirSync(proc);
  const stat = (user: number, idle: number) =>
    `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu1 0 0 0 0 0 0 0 0 0 0\nintr 1 2\n`;
  writeFileSync(join(proc, "stat"), stat(100, 900));
  writeFileSync(
    join(proc, "meminfo"),
    "MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n",
  );
  writeFileSync(join(proc, "loadavg"), "0.10 0.20 0.30 1/234 5678\n");
  writeFileSync(join(root, "os-release"), 'NAME="Debian GNU/Linux"\nID=debian\nVERSION_ID="12"\n');
  const release = join(root, "releases", "1.4.0", "bin");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "paws-runner"), "");
  symlinkSync(join(release, "paws-runner"), join(root, "paws-runner"));

  const sampleHost = createRunnerHostSampler({
    workRoot: root,
    procRoot: proc,
    osRelease: join(root, "os-release"),
    executable: join(root, "paws-runner"),
  });
  const first = sampleHost();
  expect(first.cpuPercent).toBeUndefined();
  expect(first).toMatchObject({
    cpuCount: 2,
    memoryTotalBytes: 16_384_000 * 1024,
    memoryAvailableBytes: 8_192_000 * 1024,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    osId: "debian",
    osVersion: "12",
    runnerVersion: "1.4.0",
  });
  expect(first.diskTotalBytes).toBeGreaterThan(0);
  expect(first.diskFreeBytes).toBeGreaterThanOrEqual(0);

  writeFileSync(join(proc, "stat"), stat(400, 1600));
  expect(sampleHost().cpuPercent).toBe(30);
});

test("the host sampler reports the version of the mise next to the runner binary", async () => {
  const root = temporary();
  const release = join(root, "releases", "1.4.0", "bin");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "paws-runner"), "");
  const mise = join(release, "mise");
  writeFileSync(
    mise,
    `#!/bin/sh\n[ "$1" = --version ] && [ "$PWD" = / ] && [ -z "$PAWS_SECRET" ] || exit 3\necho '2026.10.18 linux-x64 (2026-10-23)'\necho 'warning on stderr' >&2\n`,
  );
  chmodSync(mise, 0o755);
  symlinkSync(join(release, "paws-runner"), join(root, "paws-runner"));
  process.env.PAWS_SECRET = "must not reach mise";
  try {
    const sampleHost = createRunnerHostSampler({
      workRoot: root,
      procRoot: join(root, "missing"),
      executable: join(root, "paws-runner"),
    });
    expect(sampleHost().miseVersion).toBeUndefined();
    let reported: string | undefined;
    for (let attempt = 0; attempt < 200 && !reported; attempt += 1) {
      await Bun.sleep(10);
      reported = sampleHost().miseVersion;
    }
    expect(reported).toBe("2026.10.18");
    expect(sampleHost()).toMatchObject({ runnerVersion: "1.4.0", miseVersion: "2026.10.18" });
  } finally {
    delete process.env.PAWS_SECRET;
  }
});

test("a failed mise probe reports nothing and is tried again", async () => {
  const root = temporary();
  const mise = join(root, "mise");
  writeFileSync(mise, "#!/bin/sh\nexit 1\n");
  chmodSync(mise, 0o755);
  const sampleHost = createRunnerHostSampler({
    workRoot: root,
    procRoot: join(root, "missing"),
    executable: join(root, "missing"),
    mise,
  });
  expect(sampleHost().miseVersion).toBeUndefined();
  await Bun.sleep(100);
  expect(sampleHost().miseVersion).toBeUndefined();
  writeFileSync(mise, "#!/bin/sh\necho 2026.1.0 linux-arm64\n");
  let reported: string | undefined;
  for (let attempt = 0; attempt < 200 && !reported; attempt += 1) {
    await Bun.sleep(10);
    reported = sampleHost().miseVersion;
  }
  expect(reported).toBe("2026.1.0");
});

test("mise versions come only from calendar version output", () => {
  expect(miseVersionFromOutput("2026.10.18 linux-x64 (2026-10-23)\n")).toBe("2026.10.18");
  expect(miseVersionFromOutput("2026.1.0")).toBe("2026.1.0");
  expect(miseVersionFromOutput("mise 2026.10.18")).toBeNull();
  expect(miseVersionFromOutput("2026.10")).toBeNull();
  expect(miseVersionFromOutput("")).toBeNull();
});

test("the host sampler omits fields it cannot read", () => {
  const root = temporary();
  const sampleHost = createRunnerHostSampler({
    workRoot: join(root, "missing"),
    procRoot: join(root, "missing"),
    osRelease: join(root, "missing"),
    executable: join(root, "missing"),
  });
  expect(sampleHost()).toEqual({});
});

test("release versions come only from a releases/<semver> path", () => {
  expect(releaseVersionFromPath("/opt/paws-runner/releases/1.4.0/bin/paws-runner")).toBe("1.4.0");
  expect(releaseVersionFromPath("/opt/paws/releases/10.0.2")).toBe("10.0.2");
  expect(releaseVersionFromPath("/home/dev/paws/src/runner-control")).toBeNull();
  expect(releaseVersionFromPath("/opt/paws/releases/1.4/bin")).toBeNull();
});

test("a heartbeat that reports installed skills gets the manifest and can download pinned bundles", async () => {
  const runner = await fixture();
  const bundle = new Uint8Array([1, 2, 3, 4]);
  mkdirSync(join(runner.skillsRoot, "impeccable", "2.4.1"), { recursive: true });
  writeFileSync(join(runner.skillsRoot, "impeccable", "2.4.1", "skill.tar.gz"), bundle);
  const pin = {
    name: "impeccable",
    source: { kind: "npm" as const, package: "impeccable" },
    version: "2.4.1",
    sha256: "a".repeat(64),
    sizeBytes: 4,
    agents: ["claude" as const, "codex" as const],
    updatedAt: runner.now(),
  };
  saveSkill(runner.db, pin);
  saveSkill(runner.db, { ...pin, name: "gone", version: "1.0.0" });
  markSkillRemoved(runner.db, "gone", runner.now());

  const older = (await (await runner.heartbeat({}))!.json()) as Record<string, unknown>;
  expect(older.skills).toBeUndefined();

  const installed = [
    { name: "gone", version: "1.0.0", sha256: "a".repeat(64), status: "installed" },
  ];
  const reply = (await (await runner.heartbeat({ skills: installed }))!.json()) as {
    skills: unknown;
  };
  expect(reply.skills).toEqual([
    {
      name: "impeccable",
      version: "2.4.1",
      sha256: "a".repeat(64),
      sizeBytes: 4,
      agents: ["claude", "codex"],
    },
  ]);
  expect(listRunnerSkills(runner.db, runner.runnerId)).toEqual([
    { ...installed[0]!, status: "installed", error: null, waiting: null, reportedAt: runner.now() },
  ]);
  const refused = {
    name: "impeccable",
    version: "2.4.1",
    sha256: "a".repeat(64),
    status: "refused",
    error: "Skill impeccable 2.4.1 failed its checksum and was not installed.",
  };
  expect((await runner.heartbeat({ skills: [refused] }))!.status).toBe(200);
  expect(listRunnerSkills(runner.db, runner.runnerId)).toEqual([
    { ...refused, status: "refused", waiting: null, reportedAt: runner.now() },
  ]);

  const download = (await runner.fetch("/v1/skills/impeccable/2.4.1"))!;
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bundle);
  expect((await runner.fetch("/v1/skills/impeccable/2.4.0"))!.status).toBe(403);
  expect((await runner.fetch("/v1/skills/gone/1.0.0"))!.status).toBe(403);
  expect((await runner.fetch("/v1/skills/..%2Fimpeccable/2.4.1"))!.status).toBe(403);
});

test("the host sampler reports processes of the runner user outside the runner's tree", () => {
  const root = temporary();
  const proc = join(root, "proc");
  mkdirSync(proc);
  // pid (comm) state ppid ... utime(14) stime(15) ... starttime(22), in clock ticks.
  const entry = (pid: number, name: string, parent: number, cpu: number, started: number) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    const fields = ["S", parent, ...Array(9).fill(0), cpu, 0, ...Array(6).fill(0), started];
    writeFileSync(join(proc, String(pid), "stat"), `${pid} (${name}) ${fields.join(" ")} 0 0\n`);
  };
  writeFileSync(join(proc, "uptime"), "1000.00 4000.00\n");
  entry(100, "paws-runner", 1, 500, 10_000);
  entry(101, "bun", 100, 9_000, 50_000);
  entry(102, "codex-sandbox", 101, 100, 60_000);
  entry(200, "bun", 1, 40_000, 20_000);
  entry(201, "bg.sh", 1, 0, 80_000);
  const sampleHost = createRunnerHostSampler({
    workRoot: root,
    procRoot: proc,
    rootPid: 100,
    uid: process.getuid!(),
  });
  // On first sight, CPU is the average over the process lifetime: 400 s of 800 s.
  expect(sampleHost().strayProcesses).toEqual([
    { pid: 200, name: "bun", ageSeconds: 800, cpuPercent: 50 },
    { pid: 201, name: "bg.sh", ageSeconds: 200, cpuPercent: 0 },
  ]);
  writeFileSync(join(proc, "uptime"), "1010.00 4000.00\n");
  entry(200, "bun", 1, 41_600, 20_000);
  expect(sampleHost().strayProcesses?.[0]).toEqual({
    pid: 200,
    name: "bun",
    ageSeconds: 810,
    cpuPercent: 160,
  });
  const otherUser = createRunnerHostSampler({
    workRoot: root,
    procRoot: proc,
    rootPid: 100,
    uid: process.getuid!() + 1,
  });
  expect(otherUser().strayProcesses).toEqual([]);
});

test("stray processes are stored with the heartbeat and listed with the metrics", async () => {
  const runner = await fixture();
  const strayProcesses = [{ pid: 4242, name: "bun", ageSeconds: 18_000, cpuPercent: 160 }];
  expect((await runner.heartbeat({ ...sample, strayProcesses }))!.status).toBe(200);
  expect((await runner.list()).runners[0]!.metrics).toMatchObject({ strayProcesses });
  expect((await runner.heartbeat(sample))!.status).toBe(200);
  expect((await runner.list()).runners[0]!.metrics).toMatchObject({ strayProcesses: null });
  for (const stray of [
    { ...strayProcesses[0], name: "bun\u0000x" },
    { ...strayProcesses[0], pid: 1 },
    { ...strayProcesses[0], cmdline: "secret" },
  ])
    expect((await runner.heartbeat({ strayProcesses: [stray] }))!.status).toBe(403);
});

test("a runner waiting on running tasks says how many still hold the earlier version", async () => {
  const runner = await fixture();
  const pin = {
    name: "impeccable",
    source: { kind: "npm" as const, package: "impeccable" },
    version: "2.5.0",
    sha256: "b".repeat(64),
    sizeBytes: 4,
    agents: ["claude" as const],
    updatedAt: runner.now(),
  };
  saveSkill(runner.db, pin);
  const pending = { name: pin.name, version: pin.version, sha256: pin.sha256, status: "pending" };
  expect((await runner.heartbeat({ skills: [{ ...pending, waiting: 2 }] }))?.status).toBe(200);
  const list = (await runner.list()) as unknown as {
    runners: { skills: RunnerSkillView[] }[];
  };
  expect(list.runners[0]!.skills[0]).toMatchObject({ state: "installing", waiting: 2 });
  expect(skillRollouts(runner.db)[0]).toMatchObject({
    installing: [],
    waiting: [{ runner: "Host VM", tasks: 2 }],
  });
  expect((await runner.heartbeat({ skills: [pending] }))?.status).toBe(200);
  expect(skillRollouts(runner.db)[0]).toMatchObject({ installing: ["Host VM"], waiting: [] });
});

test("the runner list shows each registered skill as up to date, installing, out of date or failed", async () => {
  const runner = await fixture();
  const pin = {
    source: { kind: "npm" as const, package: "skill" },
    sha256: "b".repeat(64),
    sizeBytes: 4,
    agents: ["claude" as const],
    updatedAt: runner.now(),
  };
  for (const name of ["current", "failing", "missing", "older", "pending"])
    saveSkill(runner.db, { ...pin, name, version: "2.0.0" });
  const reported = (name: string, status: string, sha256 = pin.sha256, version = "2.0.0") => ({
    name,
    version,
    sha256,
    status,
  });
  expect(
    (
      await runner.heartbeat({
        skills: [
          reported("current", "installed"),
          { ...reported("failing", "refused"), error: "Skill failing has no SKILL.md." },
          reported("older", "installed", "c".repeat(64), "1.9.0"),
          reported("pending", "pending"),
        ],
      })
    )?.status,
  ).toBe(200);
  const list = (await runner.list()) as unknown as {
    runners: { skills: RunnerSkillView[] }[];
  };
  expect(list.runners[0]!.skills).toEqual([
    {
      name: "current",
      version: "2.0.0",
      installedVersion: "2.0.0",
      state: "up_to_date",
      error: null,
      waiting: null,
      reportedAt: runner.now(),
    },
    {
      name: "failing",
      version: "2.0.0",
      installedVersion: null,
      state: "failed",
      error: "Skill failing has no SKILL.md.",
      waiting: null,
      reportedAt: runner.now(),
    },
    {
      name: "missing",
      version: "2.0.0",
      installedVersion: null,
      state: "installing",
      error: null,
      waiting: null,
      reportedAt: null,
    },
    {
      name: "older",
      version: "2.0.0",
      installedVersion: "1.9.0",
      state: "out_of_date",
      error: null,
      waiting: null,
      reportedAt: runner.now(),
    },
    {
      name: "pending",
      version: "2.0.0",
      installedVersion: "2.0.0",
      state: "installing",
      error: null,
      waiting: null,
      reportedAt: runner.now(),
    },
  ]);
  expect(skillRollouts(runner.db).map(({ name, ...rollout }) => [name, rollout])).toEqual([
    ["current", { total: 1, upToDate: 1, installing: [], waiting: [], outOfDate: [], failed: [] }],
    [
      "failing",
      { total: 1, upToDate: 0, installing: [], waiting: [], outOfDate: [], failed: ["Host VM"] },
    ],
    [
      "missing",
      { total: 1, upToDate: 0, installing: ["Host VM"], waiting: [], outOfDate: [], failed: [] },
    ],
    [
      "older",
      { total: 1, upToDate: 0, installing: [], waiting: [], outOfDate: ["Host VM"], failed: [] },
    ],
    [
      "pending",
      { total: 1, upToDate: 0, installing: ["Host VM"], waiting: [], outOfDate: [], failed: [] },
    ],
  ]);
});

test("a heartbeat with runtimes stores them and the runner list returns them", async () => {
  const runner = await fixture();
  const failure = "Paws could not install the runtime python@3.99: mise exited with code 1.";
  expect(
    (
      await runner.heartbeat({
        ...sample,
        runtimes: [
          { tool: "node", version: "22", status: "installed" },
          { tool: "python", version: "3.99", status: "failed", error: failure },
          { tool: "aqua:cli/cli", version: "2.62.0", status: "installed" },
        ],
      })
    )?.status,
  ).toBe(200);
  const at = runner.now();
  const expected: RunnerRuntimeStatus[] = [
    { tool: "aqua:cli/cli", version: "2.62.0", status: "installed", error: null, reportedAt: at },
    { tool: "node", version: "22", status: "installed", error: null, reportedAt: at },
    { tool: "python", version: "3.99", status: "failed", error: failure, reportedAt: at },
  ];
  expect(listRunnerRuntimes(runner.db, runner.runnerId)).toEqual(expected);
  const list = (await runner.list()) as unknown as { runners: { runtimes: unknown }[] };
  expect(list.runners[0]!.runtimes).toEqual(expected);

  // A heartbeat without the field, from a runner that has not installed any, keeps the rows.
  runner.advance(15_000);
  expect((await runner.heartbeat(sample))?.status).toBe(200);
  expect(listRunnerRuntimes(runner.db, runner.runnerId)).toEqual(expected);

  // The next report replaces the last one.
  expect(
    (
      await runner.heartbeat({
        runtimes: [{ tool: "python", version: "3.99", status: "installed" }],
      })
    )?.status,
  ).toBe(200);
  expect(listRunnerRuntimes(runner.db, runner.runnerId)).toEqual([
    {
      tool: "python",
      version: "3.99",
      status: "installed",
      error: null,
      reportedAt: runner.now(),
    },
  ]);
});

test("a heartbeat with a malformed runtime is refused", async () => {
  const runner = await fixture();
  for (const runtime of [
    { tool: "--force", version: "1.0.0", status: "installed" },
    { tool: "node", version: "../22", status: "installed" },
    { tool: "node", version: "22", status: "pending" },
    { tool: "node", version: "22", status: "failed", error: "x".repeat(501) },
    { tool: "node", version: "22", status: "installed", path: "/usr/bin" },
  ])
    expect((await runner.heartbeat({ runtimes: [runtime] }))?.status).toBe(403);
  expect(listRunnerRuntimes(runner.db, runner.runnerId)).toEqual([]);
});

test("first activation ignores sign-in probes and remembers work after its lease moves", async () => {
  const runner = await fixture();
  const hasRunWork = async () => (await runner.list()).runners[0]!.hasRunWork;
  expect(await hasRunWork()).toBe(false);
  runner.db.run(
    "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at,acknowledged_at) VALUES('login',?,'login_check','{}',?,?)",
    [runner.runnerId, runner.now(), runner.now()],
  );
  expect(await hasRunWork()).toBe(false);
  // Commands retain the assignment history when runner_work is replaced during failover.
  runner.db.run(
    "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at,acknowledged_at) VALUES('review',?,'review','{}',?,?)",
    [runner.runnerId, runner.now(), runner.now()],
  );
  expect(await hasRunWork()).toBe(true);
});
