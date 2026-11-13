import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerCapacityWait } from "../src/core";
import { readAgentCredentialSteps, writeAgentCredentialSteps } from "../src/credentials";
import {
  AGENT_ACCOUNT_LEASE_GRACE_MS,
  agentCredentialCiphertextSteps,
  createAgentAccountSteps,
  recordAgentAccountUsageSteps,
  releaseAgentAccountLeaseSteps,
  takeAgentAccountLeaseSteps,
  type Db,
} from "../src/db";
import { leaseCentralAccount, UsageLimitPause } from "../src/runner-backend";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRunner } from "./runner-rows";

const NOW = 1_800_000_000_000;
const open: DialectDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  const { db } = handle;
  await withoutForeignKeys(db);
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "acme", linearOrganizationId: "org", name: "acme", createdAt: NOW }),
  );
  await seedRunner(db, "R1");
  await seedRunner(db, "R2");
  const account = (label: string) =>
    db.transaction((q) =>
      createAgentAccountSteps(q, { workspaceId: "acme", agent: "claude", label, now: NOW }),
    );
  const secrets = mkdtempSync(join(tmpdir(), "paws-agent-credential-"));
  dirs.push(secrets);
  return { db, secrets, first: (await account("First")).id, second: (await account("Second")).id };
}

const lease = (db: Db, accountId: string, runnerId: string, runId: string, now = NOW) =>
  db.transaction((q) =>
    takeAgentAccountLeaseSteps(q, { accountId, runnerId, runId, until: now, now }),
  );

forEachDialect((connect) => {
  test("a sign-in round-trips encrypted and only the lease holder writes the next version", async () => {
    const { db, secrets, first } = await setup(connect);
    const write = (runnerId: string, version: number, blob: string, now = NOW) =>
      db.transaction((q) =>
        writeAgentCredentialSteps(q, secrets, { accountId: first, runnerId, version, blob, now }),
      );
    const plaintext = '{"claudeAiOauth":{"refreshToken":"rt-secret-1"}}';
    expect(await write("R1", 1, plaintext)).toBe("written");
    const stored = await db.run((q) => agentCredentialCiphertextSteps(q, first));
    expect(stored?.ciphertext.startsWith("paws-envelope-v1\n")).toBe(true);
    expect(stored?.ciphertext).not.toContain("rt-secret-1");
    expect(await db.run((q) => readAgentCredentialSteps(q, secrets, first))).toMatchObject({
      agent: "claude",
      blob: plaintext,
      version: 1,
      runnerId: "R1",
    });

    expect(await lease(db, first, "R1", "run-1")).toBe(true);
    expect(await lease(db, first, "R2", "run-2")).toBe(false);
    expect(await write("R2", 2, "stolen")).toBe("not_holder");
    expect(await write("R1", 1, "old")).toBe("stale_version");
    expect(await write("R1", 3, "skipped")).toBe("stale_version");
    expect(await write("R1", 2, "rotated")).toBe("written");

    const later = NOW + AGENT_ACCOUNT_LEASE_GRACE_MS;
    expect(await lease(db, first, "R2", "run-2", later)).toBe(true);
    expect(await write("R1", 3, "stale runner", later)).toBe("not_holder");
    expect(await write("R2", 3, "fresh", later)).toBe("written");
    expect((await db.run((q) => readAgentCredentialSteps(q, secrets, first)))?.blob).toBe("fresh");
  });

  test("placement leases the next free account and waits when all are leased or paused", async () => {
    const { db, first, second } = await setup(connect);
    const place = (runId: string) =>
      leaseCentralAccount(db, {
        workspaceId: "acme",
        agent: "claude",
        runnerId: "R1",
        runId,
        until: NOW,
        now: NOW,
      });
    await db.run((q) =>
      recordAgentAccountUsageSteps(q, {
        accountId: first,
        runnerId: "R2",
        limits: [{ window: "5h", usedPercent: 100, resetsAt: NOW + 60_000 }],
        observedAt: NOW,
      }),
    );
    expect(await place("run-1")).toEqual({ accountId: second, reason: null });
    await expect(place("run-2")).rejects.toBeInstanceOf(RunnerCapacityWait);

    await db.run((q) =>
      recordAgentAccountUsageSteps(q, {
        accountId: first,
        runnerId: "R2",
        limits: [{ window: "5h", usedPercent: 40, resetsAt: NOW + 60_000 }],
        observedAt: NOW + 1,
      }),
    );
    expect(await place("run-2")).toEqual({ accountId: first, reason: null });
    await expect(place("run-3")).rejects.toBeInstanceOf(RunnerCapacityWait);

    for (const accountId of [first, second])
      await db.run((q) =>
        recordAgentAccountUsageSteps(q, {
          accountId,
          runnerId: "R1",
          limits: [{ window: "week", usedPercent: 100, resetsAt: NOW + 120_000 }],
          observedAt: NOW + 2,
        }),
      );
    const paused = await place("run-3").catch((error: unknown) => error);
    expect(paused).toBeInstanceOf(UsageLimitPause);
    expect((paused as UsageLimitPause).resetsAt).toBe(NOW + 120_000);

    await seed(db, (q) =>
      q.orm.update(q.t.agentAccount).set({ extraUsage: 1 }).where(eq(q.t.agentAccount.id, second)),
    );
    await db.run((q) =>
      releaseAgentAccountLeaseSteps(q, { accountId: second, runnerId: "R1", runId: "run-1" }),
    );
    expect(await place("run-3")).toEqual({ accountId: second, reason: "extra_usage" });
  });
});
