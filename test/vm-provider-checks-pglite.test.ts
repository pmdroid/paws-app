import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boatTokenPath, exeDevTokenPath } from "../src/config";
import { removeSecret, saveSecret } from "../src/credentials";
import { vmProviderChecksSteps, type Db } from "../src/db";
import { setJournalSink } from "../src/journal";
import { createFakeExeDev } from "../src/provisioning";
import {
  createVmProviderChecks,
  exeDevKeyCheck,
  type VmProviderKeyCheck,
} from "../src/vm-provider-checks";
import { describePglite, type PgliteTestDb } from "./pglite-fixtures";

const opened: PgliteTestDb[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function setup(connect: () => Promise<PgliteTestDb>) {
  const handle = await connect();
  opened.push(handle);
  const home = mkdtempSync(join(tmpdir(), "paws-vm-checks-"));
  homes.push(home);
  const exe = createFakeExeDev();
  let clock = 1_000;
  const checks = createVmProviderChecks({
    db: handle.db,
    home,
    checks: { "exe-dev": exeDevKeyCheck(exe) },
    now: () => clock,
  });
  return { db: handle.db, home, exe, checks, tick: () => (clock += 1_000) };
}

const rows = (db: Db) => db.run((q) => vmProviderChecksSteps(q));

describePglite((connect) => {
  test("a working ls stores working, a 401 keeps last_working_at, a timeout is unreachable", async () => {
    const { db, home, exe, checks, tick } = await setup(connect);
    await saveSecret(exeDevTokenPath(home), "exe-token");
    exe.addVm("one");
    exe.addVm("two", { status: "stopped" });

    expect(await checks.runVmProviderCheck("exe-dev")).toEqual({
      name: "exe-dev",
      state: "working",
      message: "exe.dev accepted the key.",
      facts: [
        { name: "key", text: "exe.dev accepted the key", level: "ok" },
        { name: "vms", text: "2 VMs, 1 not running", level: "ok" },
      ],
      checkedAt: 1_000,
      lastWorkingAt: 1_000,
    });

    tick();
    exe.fail("listVms", "unauthorized", { status: 401 });
    const rejected = await checks.runVmProviderCheck("exe-dev");
    expect(rejected).toMatchObject({
      state: "rejected",
      message: "exe.dev refused the key (HTTP 401).",
      checkedAt: 2_000,
      lastWorkingAt: 1_000,
    });

    tick();
    exe.fail("listVms", "timeout");
    expect(await checks.runVmProviderCheck("exe-dev")).toMatchObject({
      state: "unreachable",
      checkedAt: 3_000,
      lastWorkingAt: 1_000,
    });
    expect(await rows(db)).toHaveLength(1);
    expect(JSON.stringify(await rows(db))).not.toContain("exe-token");
    expect(exe.calls.every((call) => call.operation === "listVms")).toBe(true);
  });

  test("a check that does not answer in time is unreachable", async () => {
    const handle = await connect();
    opened.push(handle);
    const home = mkdtempSync(join(tmpdir(), "paws-vm-checks-"));
    homes.push(home);
    await saveSecret(boatTokenPath(home), "boat-token");
    const hang: VmProviderKeyCheck = () => new Promise(() => {});
    const checks = createVmProviderChecks({
      db: handle.db,
      home,
      checks: { boat: hang },
      timeoutMs: 20,
    });
    expect(await checks.runVmProviderCheck("boat")).toMatchObject({
      state: "unreachable",
      lastWorkingAt: null,
    });
  });

  test("a key that isn't saved gets no check and no row, and clearing one deletes its row", async () => {
    const { db, home, exe, checks } = await setup(connect);
    expect(await checks.runVmProviderCheck("exe-dev")).toBeNull();
    expect(exe.calls).toEqual([]);
    expect(await rows(db)).toEqual([]);

    await saveSecret(exeDevTokenPath(home), "exe-token");
    await checks.runVmProviderCheck("exe-dev");
    expect(await rows(db)).toHaveLength(1);

    await removeSecret(exeDevTokenPath(home));
    await checks.runVmProviderChecks();
    expect(await rows(db)).toEqual([]);
    expect(exe.calls).toHaveLength(1);
  });

  test("each run checks every saved key once", async () => {
    const handle = await connect();
    opened.push(handle);
    const home = mkdtempSync(join(tmpdir(), "paws-vm-checks-"));
    homes.push(home);
    await saveSecret(exeDevTokenPath(home), "exe-token");
    await saveSecret(boatTokenPath(home), "boat-token");
    const ran: string[] = [];
    const stub =
      (name: string): VmProviderKeyCheck =>
      async () => {
        ran.push(name);
        return { state: "working", message: "ok", facts: [] };
      };
    const checks = createVmProviderChecks({
      db: handle.db,
      home,
      checks: { "exe-dev": stub("exe-dev"), boat: stub("boat"), instabox: stub("instabox") },
    });
    await checks.runVmProviderChecks();
    expect(ran).toEqual(["exe-dev", "boat"]);
    expect((await rows(handle.db)).map((row) => row.name).sort()).toEqual(["boat", "exe-dev"]);
  });

  test("the journal has one line per state change and none for an unchanged state", async () => {
    const { home, exe, checks } = await setup(connect);
    await saveSecret(exeDevTokenPath(home), "exe-token");
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      await checks.runVmProviderCheck("exe-dev");
      await checks.runVmProviderCheck("exe-dev");
      exe.fail("listVms", "unauthorized", { status: 403, times: 2 });
      await checks.runVmProviderCheck("exe-dev");
      await checks.runVmProviderCheck("exe-dev");
      await checks.runVmProviderCheck("exe-dev");
    } finally {
      restore();
    }
    const changes = lines.filter((line) => line.includes("vm provider key"));
    expect(changes).toEqual([
      "vm provider key exe-dev: unchecked -> working",
      "vm provider key exe-dev: working -> rejected",
      "vm provider key exe-dev: rejected -> working",
    ]);
    expect(lines.join("\n")).not.toContain("exe-token");
  });
});
