import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { consumeWorkspaceBootstrap, migrate, openDatabase, putWorkspaceUser } from "../src/db";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createRunnerHostSampler } from "../src/runner-daemon";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { releaseVersion } from "../src/runner-protocol";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-host-status-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the sampler reads CPU from the delta, memory, load, disk, OS and the installed version", () => {
  const proc = join(root, "proc");
  mkdirSync(proc);
  writeFileSync(join(proc, "meminfo"), "MemTotal:       16384 kB\nMemAvailable:    4096 kB\n");
  writeFileSync(join(proc, "loadavg"), "0.50 0.25 0.10 1/200 4242\n");
  writeFileSync(join(root, "os-release"), 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n');
  mkdirSync(join(root, "releases", "1.4.0"), { recursive: true });
  symlinkSync(join(root, "releases", "1.4.0"), join(root, "current"));
  const sample = createRunnerHostSampler({
    workRoot: join(root, "missing", "work"),
    release: join(root, "current"),
    proc,
    osRelease: [join(root, "absent"), join(root, "os-release")],
  });
  writeFileSync(join(proc, "stat"), "cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n");
  const first = sample();
  expect(first.cpuPercent).toBeUndefined();
  expect(first).toMatchObject({
    memoryTotalBytes: 16384 * 1024,
    memoryAvailableBytes: 4096 * 1024,
    load1: 0.5,
    load5: 0.25,
    load15: 0.1,
    osId: "ubuntu",
    osVersion: "24.04",
    runnerVersion: "1.4.0",
  });
  expect(first.diskTotalBytes).toBeGreaterThan(0);
  expect(first.diskFreeBytes).toBeGreaterThanOrEqual(0);
  writeFileSync(join(proc, "stat"), "cpu  250 0 150 900 100 0 0 0 0 0\n");
  expect(sample().cpuPercent).toBe(50);
  writeFileSync(join(proc, "stat"), "garbage\n");
  writeFileSync(join(root, "os-release"), "ID=../../etc\n");
  const broken = sample();
  expect(broken.cpuPercent).toBeUndefined();
  expect(broken.osId).toBeUndefined();
  expect(releaseVersion(join(root, "nothing"))).toBeNull();
});

test("a heartbeat round-trip stores host metrics and the runner list returns them", async () => {
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
    serverVersion: "2.0.0",
  });
  const client = await createRunnerKey(join(root, "client"));
  async function paired(name: string) {
    const pending = await control.beginPairing({ name, csr: client.csr });
    return (await control.approvePairing(principal, pending.code)).runnerId;
  }
  const current = await paired("Current VM");
  const older = await paired("Older VM");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const workHttp = createRunnerWorkHttp(work);
  const heartbeat = (runnerId: string, body: unknown) =>
    workHttp(
      new Request("https://runner.invalid/v1/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      runnerId,
    ).then((response) => response!);
  const metrics = {
    cpuPercent: 12.5,
    memoryTotalBytes: 8_589_934_592,
    memoryAvailableBytes: 4_294_967_296,
    load1: 0.5,
    load5: 0.25,
    load15: 0.1,
    diskTotalBytes: 107_374_182_400,
    diskFreeBytes: 53_687_091_200,
    osId: "debian",
    osVersion: "12",
    runnerVersion: "1.4.0",
  };
  const accepted = await heartbeat(current, { capacity: 2, ...metrics });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ leases: [], fenced: [] });
  const legacy = await heartbeat(older, {});
  expect(legacy.status).toBe(200);
  expect((await heartbeat(older, { cpuPercent: 101 })).status).toBe(403);
  expect((await heartbeat(older, { osId: "x".repeat(65) })).status).toBe(403);
  expect((await heartbeat(older, { unknown: 1 })).status).toBe(403);

  const list = async () => {
    const response = await createRunnerHttp(control).browser(
      new Request("https://paws.invalid/api/runners"),
      principal,
    );
    return (await response!.json()) as {
      runners: { id: string; host: Record<string, unknown> | null; idle: boolean }[];
      serverVersion: string | null;
    };
  };
  let listed = await list();
  expect(listed.serverVersion).toBe("2.0.0");
  expect(listed.runners.find((runner) => runner.id === current)).toMatchObject({
    host: { ...metrics, reportedAt: now },
    idle: true,
  });
  expect(listed.runners.find((runner) => runner.id === older)).toMatchObject({
    host: null,
    idle: true,
  });

  now += 30_000;
  expect((await heartbeat(current, { osId: "debian" })).status).toBe(200);
  db.run("INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES(?,?,?,?,?)", [
    "pending-probe",
    current,
    "probe",
    "{}",
    now + 60_000,
  ]);
  listed = await list();
  expect(listed.runners.find((runner) => runner.id === current)).toMatchObject({
    host: { osId: "debian", cpuPercent: null, runnerVersion: null, reportedAt: now },
    idle: false,
  });
  now += 120_000;
  expect((await list()).runners.find((runner) => runner.id === current)!.idle).toBe(true);
  db.close();
}, 30_000);
