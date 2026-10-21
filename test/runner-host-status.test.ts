import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeWorkspaceBootstrap, migrate, openDatabase, putWorkspaceUser } from "../src/db";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createRunnerHostSampler } from "../src/runner-daemon";
import { cpuCountFromStat } from "../src/runner-daemon/host";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { releaseVersionFromPath } from "../src/runner-protocol";
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
  const pending = await control.beginPairing({ name: "Host VM", csr: client.csr });
  const { runnerId } = await control.approvePairing(principal, pending.code);
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const http = createRunnerWorkHttp(work);
  const browser = createRunnerHttp(control);
  return {
    db,
    runnerId,
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
        runners: { id: string; metrics: unknown; os: unknown; version: unknown; idle: boolean }[];
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
  expect((await runner.heartbeat({ ...sample, cpuPercent: 5, cpuCount: 8 }))!.status).toBe(200);
  const updated = (await runner.list()).runners[0]!;
  expect(updated.metrics).toMatchObject({
    cpuPercent: 5,
    cpuCount: 8,
    reportedAt: runner.now(),
  });
  expect((await runner.heartbeat({ ...sample, cpuPercent: 5 }))!.status).toBe(200);
  expect((await runner.list()).runners[0]!.metrics).toMatchObject({ cpuCount: null });
  expect(runner.db.query("SELECT COUNT(*) AS count FROM runner_host_status").get()).toEqual({
    count: 1,
  });
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
    { memoryTotalBytes: -1 },
    { osId: "ubuntu; rm -rf /" },
    { runnerVersion: "1.2" },
    { hostname: "leak" },
    { cpuCount: 0 },
    { cpuCount: 1.5 },
    { cpuCount: 1025 },
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
    `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu1 ${user} 0 0 ${idle} 0 0 0 0 0 0\n`;
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
    memoryTotalBytes: 16_384_000 * 1024,
    memoryAvailableBytes: 8_192_000 * 1024,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    osId: "debian",
    osVersion: "12",
    runnerVersion: "1.4.0",
    cpuCount: 2,
  });
  expect(first.diskTotalBytes).toBeGreaterThan(0);
  expect(first.diskFreeBytes).toBeGreaterThanOrEqual(0);

  writeFileSync(join(proc, "stat"), stat(400, 1600));
  expect(sampleHost().cpuPercent).toBe(30);
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

test("cpu count counts cpuN lines and ignores the aggregate", () => {
  expect(cpuCountFromStat("cpu  1 0 0 1 0 0 0 0 0 0\n")).toBeUndefined();
  expect(cpuCountFromStat("cpu  1 0 0 1\ncpu0 1 0 0 1\ncpu1 1 0 0 1\n")).toBe(2);
  const tooMany = [
    "cpu  1 0 0 1",
    ...Array.from({ length: 1025 }, (_, index) => `cpu${index} 1 0 0 1`),
  ].join("\n");
  expect(cpuCountFromStat(tooMany)).toBeUndefined();
});

test("release versions come only from a releases/<semver> path", () => {
  expect(releaseVersionFromPath("/opt/paws-runner/releases/1.4.0/bin/paws-runner")).toBe("1.4.0");
  expect(releaseVersionFromPath("/opt/paws/releases/10.0.2")).toBe("10.0.2");
  expect(releaseVersionFromPath("/home/dev/paws/src/runner-control")).toBeNull();
  expect(releaseVersionFromPath("/opt/paws/releases/1.4/bin")).toBeNull();
});
