import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { createRunnerControl, createRunnerHttp, serverVersion } from "../src/runner-control";
import { createRunnerHostSampler, releaseVersion } from "../src/runner-daemon";
import { initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import { workspaceId, type WorkspacePrincipal } from "../src/workspace";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

function directory() {
  const root = mkdtempSync(join(tmpdir(), "paws-host-status-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function fixture() {
  const db = new Database(":memory:");
  cleanup.push(() => db.close());
  db.run("PRAGMA foreign_keys=ON");
  migrate(db);
  let at = 1_800_000_000_000;
  const workspace = workspaceId();
  db.run("INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES(?,?,?,?)", [
    workspace,
    "host-org",
    "Host",
    at,
  ]);
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "host-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace,
    userId,
    role: "owner",
    active: true,
    teamIds: [],
    now: at,
  });
  const principal: WorkspacePrincipal = {
    workspaceId: workspace,
    userId,
    role: "owner",
    teamIds: [],
    authenticatedAt: at,
  };
  const runnerId = workspaceId();
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
    [runnerId, workspace, userId, "Host runner", at],
  );
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "host",
    privateKey: signing.privateKey,
    now: () => at,
  });
  const authorityRoot = join(directory(), "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(authorityRoot),
    certificateRoot: authorityRoot,
    disconnect() {},
    now: () => at,
  });
  const runnerHttp = createRunnerWorkHttp(work);
  const browser = createRunnerHttp(control, { serverVersion: "4.5.6" });
  return {
    db,
    runnerId,
    advance(ms: number) {
      at += ms;
      return at;
    },
    heartbeat(body: unknown) {
      return runnerHttp(
        new Request("https://runner.invalid/v1/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        runnerId,
      );
    },
    async list() {
      const response = await browser.browser(
        new Request("https://paws.invalid/api/runners"),
        principal,
      );
      return (await response!.json()) as {
        runners: { id: string; host: Record<string, unknown> | null; idle: boolean }[];
        serverVersion: string | null;
      };
    },
  };
}

const sample = {
  cpuPercent: 12.5,
  memoryTotalBytes: 8_589_934_592,
  memoryAvailableBytes: 4_294_967_296,
  load1: 0.5,
  load5: 0.25,
  load15: 0.125,
  diskFreeBytes: 107_374_182_400,
  diskTotalBytes: 214_748_364_800,
  osId: "debian",
  osVersion: "12",
  runnerVersion: "1.2.3",
};

test("a heartbeat round-trip stores the host sample and the runner list returns it", async () => {
  const runner = await fixture();
  const before = await runner.list();
  expect(before.serverVersion).toBe("4.5.6");
  expect(before.runners).toEqual([expect.objectContaining({ host: null, idle: true })]);

  const reportedAt = runner.advance(1_000);
  const response = await runner.heartbeat({ capacity: 2, ...sample });
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ leases: [], fenced: [] });
  const listed = await runner.list();
  expect(listed.runners[0]!.host).toEqual({ ...sample, reportedAt });
  expect(listed.runners[0]!.idle).toBe(true);

  const next = runner.advance(1_000);
  await runner.heartbeat({ osId: "ubuntu", osVersion: "24.04" });
  expect((await runner.list()).runners[0]!.host).toEqual({
    cpuPercent: null,
    memoryTotalBytes: null,
    memoryAvailableBytes: null,
    load1: null,
    load5: null,
    load15: null,
    diskFreeBytes: null,
    diskTotalBytes: null,
    osId: "ubuntu",
    osVersion: "24.04",
    runnerVersion: null,
    reportedAt: next,
  });
  expect(
    runner.db.query("SELECT count(*) AS n FROM runner_host_status").get() as { n: number },
  ).toEqual({ n: 1 });
});

test("a heartbeat without host fields is still accepted", async () => {
  const runner = await fixture();
  for (const body of [{}, { capacity: 3 }]) {
    const response = await runner.heartbeat(body);
    expect(response!.status).toBe(200);
  }
  expect((await runner.list()).runners[0]!.host).toBeNull();
});

test("out-of-range or unknown heartbeat fields are rejected", async () => {
  const runner = await fixture();
  for (const body of [
    { cpuPercent: 101 },
    { memoryTotalBytes: -1 },
    { osId: "Debian Linux" },
    { runnerVersion: "1.2" },
    { hostname: "leak" },
  ])
    expect((await runner.heartbeat(body))!.status).toBe(403);
  expect((await runner.list()).runners[0]!.host).toBeNull();
});

test("pending commands and unended work make a runner busy", async () => {
  const runner = await fixture();
  runner.db.run(
    "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES('pending',?,'cancel','{}',?)",
    [runner.runnerId, runner.advance(0) + 60_000],
  );
  expect((await runner.list()).runners[0]!.idle).toBe(false);
  runner.db.run("UPDATE runner_command SET acknowledged_at=1 WHERE id='pending'");
  expect((await runner.list()).runners[0]!.idle).toBe(true);
});

test("the sampler reads proc, os-release, disk and the release pointer", async () => {
  const root = directory();
  const proc = join(root, "proc");
  mkdirSync(proc);
  const stat = (busy: number, idle: number) =>
    writeFileSync(join(proc, "stat"), `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n`);
  stat(100, 900);
  writeFileSync(
    join(proc, "meminfo"),
    "MemTotal:        2048 kB\nMemFree:          100 kB\nMemAvailable:     1024 kB\n",
  );
  writeFileSync(join(proc, "loadavg"), "0.10 0.20 0.30 1/200 4242\n");
  writeFileSync(join(root, "os-release"), 'NAME="Debian GNU/Linux"\nID=debian\nVERSION_ID="12"\n');
  mkdirSync(join(root, "releases", "2.0.1"), { recursive: true });
  symlinkSync(join(root, "releases", "2.0.1"), join(root, "current"));
  const sampler = createRunnerHostSampler({
    workRoot: root,
    releasePointer: join(root, "current"),
    procRoot: proc,
    osRelease: join(root, "os-release"),
  });

  const first = await sampler();
  expect(first.cpuPercent).toBeUndefined();
  expect(first).toMatchObject({
    memoryTotalBytes: 2048 * 1024,
    memoryAvailableBytes: 1024 * 1024,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    osId: "debian",
    osVersion: "12",
    runnerVersion: "2.0.1",
  });
  expect(first.diskTotalBytes).toBeGreaterThan(0);
  expect(first.diskFreeBytes).toBeGreaterThanOrEqual(0);

  stat(130, 970);
  expect((await sampler()).cpuPercent).toBe(30);

  const empty = createRunnerHostSampler({
    workRoot: join(root, "missing"),
    procRoot: join(root, "missing"),
    osRelease: join(root, "missing"),
  });
  expect(await empty()).toEqual({});
});

test("release versions come from a releases/X.Y.Z target only", async () => {
  const root = directory();
  mkdirSync(join(root, "releases", "1.2.3"), { recursive: true });
  mkdirSync(join(root, "checkout"));
  symlinkSync(join(root, "releases", "1.2.3"), join(root, "current"));
  expect(await releaseVersion(join(root, "current"))).toBe("1.2.3");
  expect(await releaseVersion(join(root, "checkout"))).toBeNull();
  expect(await releaseVersion(join(root, "missing"))).toBeNull();
  expect(serverVersion(join(root, "current"))).toBe("1.2.3");
  expect(serverVersion(join(root, "checkout"))).toBeNull();
  expect(serverVersion(join(root, "missing"))).toBeNull();
});
