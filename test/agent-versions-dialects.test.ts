import { afterEach, expect, test } from "bun:test";
import {
  agentCatalogSummarySteps,
  lastAgentCatalogRefreshSteps,
  listAgentVersionsSteps,
  markAgentCatalogRefreshedSteps,
  readAgentVersionSteps,
  readNpmIntegritySteps,
  readNpmPackageSteps,
  saveAgentVersionsSteps,
  saveNpmPackageSteps,
  touchNpmPackageSteps,
  type AgentVersionRow,
  type NpmVersionMetadata,
} from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const metadata = (integrity: string | null): NpmVersionMetadata => ({
  publishedAt: 1,
  integrity,
  deprecated: null,
  dependencies: { left: "^1.0.0" },
  optionalDependencies: {},
});

const version = (row: Partial<AgentVersionRow> & { version: string }): AgentVersionRow => ({
  agent: "codex",
  publishedAt: null,
  integrity: `sha-${row.version}`,
  status: "eligible",
  firstSeenAt: 1,
  reason: null,
  nativeVersion: null,
  checkedAt: 1,
  ...row,
});

forEachDialect((connect) => {
  test("a registry document stores, touches and keeps the first integrity of each version", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    expect(await db.run((q) => readNpmPackageSteps(q, "pkg"))).toBeNull();

    const first = { "1.0.0": metadata("sha-a"), "1.1.0": metadata(null) };
    await db.transaction((q) => saveNpmPackageSteps(q, "pkg", '"e1"', first, 10));
    expect(await db.run((q) => readNpmPackageSteps(q, "pkg"))).toEqual({
      etag: '"e1"',
      fetchedAt: 10,
      versions: first,
    });
    await db.run((q) => touchNpmPackageSteps(q, "pkg", 20));
    expect((await db.run((q) => readNpmPackageSteps(q, "pkg")))?.fetchedAt).toBe(20);

    await db.transaction((q) =>
      saveNpmPackageSteps(q, "pkg", null, { "1.0.0": metadata("sha-a") }, 30),
    );
    expect(await db.run((q) => readNpmIntegritySteps(q, "pkg", "1.0.0"))).toEqual({
      integrity: "sha-a",
      firstSeenAt: 10,
      changedIntegrity: null,
    });
    await db.transaction((q) =>
      saveNpmPackageSteps(q, "pkg", null, { "1.0.0": metadata("sha-b") }, 40),
    );
    await db.transaction((q) =>
      saveNpmPackageSteps(q, "pkg", null, { "1.0.0": metadata("sha-c") }, 50),
    );
    expect(await db.run((q) => readNpmIntegritySteps(q, "pkg", "1.0.0"))).toEqual({
      integrity: "sha-a",
      firstSeenAt: 10,
      changedIntegrity: "sha-b",
    });
    expect(await db.run((q) => readNpmIntegritySteps(q, "pkg", "1.1.0"))).toBeNull();
  });

  test("the agent catalog lists newest publication first, unpublished last, and summarises each agent", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    expect(await db.run(lastAgentCatalogRefreshSteps)).toBeNull();
    await db.transaction((q) =>
      saveAgentVersionsSteps(q, [
        version({ version: "1.0.0", publishedAt: 100 }),
        version({ version: "2.0.0", publishedAt: 200 }),
        version({ version: "3.0.0" }),
        version({
          version: "2.1.0",
          publishedAt: 210,
          status: "refused",
          reason: "Integrity changed",
        }),
        version({ agent: "claude", version: "0.9.0", publishedAt: 50, checkedAt: 7 }),
      ]),
    );
    await db.transaction((q) =>
      saveAgentVersionsSteps(q, [
        version({ version: "1.0.0", publishedAt: 100, integrity: "other", checkedAt: 5 }),
      ]),
    );

    expect((await db.run((q) => listAgentVersionsSteps(q))).map((row) => row.version)).toEqual([
      "0.9.0",
      "2.1.0",
      "2.0.0",
      "1.0.0",
      "3.0.0",
    ]);
    expect(await db.run((q) => readAgentVersionSteps(q, "codex", "1.0.0"))).toEqual(
      version({ version: "1.0.0", publishedAt: 100, checkedAt: 5 }),
    );
    expect(await db.run((q) => readAgentVersionSteps(q, "codex", "9.0.0"))).toBeNull();
    expect(await db.run(agentCatalogSummarySteps)).toEqual([
      { agent: "claude", offered: "0.9.0", refused: [], checkedAt: 7 },
      {
        agent: "codex",
        offered: "3.0.0",
        refused: [{ version: "2.1.0", reason: "Integrity changed" }],
        checkedAt: 5,
      },
    ]);

    await db.run((q) => markAgentCatalogRefreshedSteps(q, 60));
    await db.run((q) => markAgentCatalogRefreshedSteps(q, 70));
    expect(await db.run(lastAgentCatalogRefreshSteps)).toBe(70);
  });
});
