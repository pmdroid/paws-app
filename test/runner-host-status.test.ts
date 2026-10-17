import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeWorkspaceBootstrap, migrate, openDatabase, putWorkspaceUser } from "../src/db";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createHostSampler } from "../src/runner-daemon";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

function temporary() {
  return mkdtempSync(join(tmpdir(), "paws-host-status-"));
}

test("the host sampler reads /proc, os-release, disk and the installed release", async () => {
  const root = temporary();
  try {
    const proc = join(root, "proc");
    mkdirSync(proc);
    writeFileSync(
      join(proc, "meminfo"),
      "MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n",
    );
    writeFileSync(join(proc, "loadavg"), "0.80 0.55 0.40 2/345 6789\n");
    writeFileSync(join(proc, "stat"), "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4\n");
    writeFileSync(
      join(root, "os-release"),
      'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n',
    );
    mkdirSync(join(root, "releases/0.15.0/bin"), { recursive: true });
    symlinkSync(join(root, "releases/0.15.0"), join(root, "current"));
    const sample = createHostSampler({
      workRoot: root,
      procRoot: proc,
      osRelease: join(root, "os-release"),
      executable: join(root, "current/bin/paws-runner"),
    });
    const first = await sample();
    expect(first.cpuPercent).toBeUndefined();
    expect(first).toMatchObject({
      memoryTotalBytes: 16_384_000 * 1024,
      memoryAvailableBytes: 8_192_000 * 1024,
      load1: 0.8,
      load5: 0.55,
      load15: 0.4,
      osId: "ubuntu",
      osVersion: "24.04",
      runnerVersion: "0.15.0",
    });
    expect(first.diskTotalBytes).toBeGreaterThan(0);
    expect(first.diskFreeBytes).toBeLessThanOrEqual(first.diskTotalBytes!);
    // 150 busy of 200 ticks since the previous sample.
    writeFileSync(join(proc, "stat"), "cpu  200 0 150 850 0 0 0 0 0 0\n");
    expect((await sample()).cpuPercent).toBe(75);

    const missing = createHostSampler({
      workRoot: join(root, "absent"),
      procRoot: join(root, "absent"),
      osRelease: join(root, "absent"),
      executable: "/usr/bin/bun",
    });
    expect(await missing()).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a heartbeat round-trip stores host metrics and the runner list returns them", async () => {
  const root = temporary();
  const db = openDatabase(join(root, "paws.sqlite"));
  try {
    migrate(db);
    let now = Date.now();
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: "owner",
      name: "Owner",
      email: "owner@example.invalid",
    });
    const workspace = consumeWorkspaceBootstrap(db, {
      id: workspaceId(),
      organizationId: "fixture-host",
      name: "Fixture",
      userId,
      tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "fixture-host", now)),
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
      serverVersion: "0.15.0",
      now: () => now,
    });
    const client = await createRunnerKey(join(root, "client"));
    const pending = await control.beginPairing({ name: "build-01", csr: client.csr });
    const { runnerId } = await control.approvePairing(principal, pending.code);
    const work = createRunnerWorkHttp(
      createRunnerWork({
        db,
        keyId: "fixture",
        privateKey: generateKeyPairSync("ed25519").privateKey,
        now: () => now,
      }),
    );
    const browser = createRunnerHttp(control);
    const heartbeat = (body: unknown) =>
      work(
        new Request("https://runner.invalid/v1/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        runnerId,
      );
    async function listed() {
      const response = await browser.browser(
        new Request("https://paws.invalid/api/runners"),
        principal,
      );
      return (await response!.json()) as {
        runners: { id: string; idle: boolean; lastSeenAt: number; host: unknown }[];
        serverVersion: string | null;
      };
    }

    let list = await listed();
    expect(list.serverVersion).toBe("0.15.0");
    expect(list.runners[0]).toMatchObject({ id: runnerId, host: null, idle: true });

    const metrics = {
      cpuPercent: 23.4,
      memoryTotalBytes: 17_179_869_184,
      memoryAvailableBytes: 11_000_000_000,
      load1: 0.8,
      load5: 0.6,
      load15: 0.5,
      diskTotalBytes: 500_000_000_000,
      diskFreeBytes: 120_000_000_000,
      osId: "ubuntu",
      osVersion: "24.04",
      runnerVersion: "0.14.2",
    };
    expect((await heartbeat({ capacity: 2, ...metrics }))!.status).toBe(200);
    list = await listed();
    expect(list.runners[0]!.lastSeenAt).toBe(now);
    expect(list.runners[0]!.host).toEqual({ ...metrics, reportedAt: now });

    // Only the latest sample is kept; fields a runner leaves out become null.
    now += 15_000;
    expect((await heartbeat({ cpuPercent: 5, runnerVersion: "0.15.0" }))!.status).toBe(200);
    expect(db.query("SELECT count(*) AS n FROM runner_host_status").get()).toEqual({ n: 1 });
    expect((await listed()).runners[0]!.host).toMatchObject({
      cpuPercent: 5,
      memoryTotalBytes: null,
      osId: null,
      runnerVersion: "0.15.0",
      reportedAt: now,
    });

    // An older runner sends no host fields and is still accepted.
    now += 15_000;
    expect((await heartbeat({}))!.status).toBe(200);
    list = await listed();
    expect(list.runners[0]!.lastSeenAt).toBe(now);
    expect(list.runners[0]!.host).toMatchObject({ cpuPercent: 5, reportedAt: now - 15_000 });

    for (const invalid of [
      { cpuPercent: 101 },
      { memoryTotalBytes: -1 },
      { osId: "Ubuntu Linux" },
      { runnerVersion: "1.2" },
      { unknown: true },
    ])
      expect((await heartbeat(invalid))!.status).toBe(403);

    db.run(
      `INSERT INTO runner_command (id,runner_id,kind,envelope,expires_at) VALUES ('pending',?,'probe','{}',?)`,
      [runnerId, now + 60_000],
    );
    expect((await listed()).runners[0]!.idle).toBe(false);
    db.run("UPDATE runner_command SET acknowledged_at=? WHERE id='pending'", [now]);
    expect((await listed()).runners[0]!.idle).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
