import { describe, expect, test } from "bun:test";
import {
  agentCatalogSummary,
  listAgentVersions,
  migrate,
  openDatabase,
  readAgentVersion,
} from "../db";
import {
  AGENT_CATALOG_REFRESH_MS,
  createAgentCatalog,
  createFakeNpmRegistry,
  parsePackageDocument,
  type AgentPackage,
} from "./index";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-24T12:00:00Z");
const DEMO: Record<string, AgentPackage> = {
  demo: { package: "demo-agent", native: "demo-agent" },
};

function setup(agents: Record<string, AgentPackage> = DEMO) {
  const db = openDatabase(":memory:");
  migrate(db);
  const npm = createFakeNpmRegistry();
  let clock = NOW;
  const errors: unknown[] = [];
  const catalog = createAgentCatalog({
    db,
    registry: npm.registry,
    agents,
    now: () => clock,
    onError: (error) => errors.push(error),
  });
  return {
    db,
    npm,
    catalog,
    errors,
    advance: (ms: number) => (clock += ms),
    status: (agent: string, version: string) => readAgentVersion(db, agent, version)?.status,
    row: (agent: string, version: string) => readAgentVersion(db, agent, version),
  };
}

const sha = (n: number) => `sha512-${String(n).padStart(4, "0")}`;

describe("agent version catalog", () => {
  test("a version is eligible once it has been on npm for 48 hours", async () => {
    const { npm, catalog, status, row } = setup();
    npm.publish("demo-agent", "1.0.0", { publishedAt: NOW - 47 * HOUR, integrity: sha(1) });
    npm.publish("demo-agent", "0.9.0", { publishedAt: NOW - 49 * HOUR, integrity: sha(2) });
    await catalog.refresh();
    expect(status("demo", "1.0.0")).toBe("waiting");
    expect(row("demo", "1.0.0")?.reason).toContain("less than 48 hours");
    expect(status("demo", "0.9.0")).toBe("eligible");
    expect(row("demo", "0.9.0")).toMatchObject({
      publishedAt: NOW - 49 * HOUR,
      integrity: sha(2),
      firstSeenAt: NOW,
      reason: null,
      nativeVersion: "0.9.0",
    });
  });

  test("deprecated versions and prereleases are not eligible", async () => {
    const { npm, catalog, status, row } = setup();
    const old = NOW - 100 * HOUR;
    npm.publish("demo-agent", "1.0.0", { publishedAt: old, integrity: sha(1), deprecated: "bad" });
    npm.publish("demo-agent", "1.1.0-beta.1", { publishedAt: old, integrity: sha(2) });
    npm.publish("demo-agent", "1.0.1", { publishedAt: old, integrity: sha(3) });
    await catalog.refresh();
    expect(status("demo", "1.0.0")).toBe("ineligible");
    expect(row("demo", "1.0.0")?.reason).toContain("deprecated: bad");
    expect(status("demo", "1.1.0-beta.1")).toBe("ineligible");
    expect(row("demo", "1.1.0-beta.1")?.reason).toContain("prerelease");
    expect(status("demo", "1.0.1")).toBe("eligible");

    npm.deprecate("demo-agent", "1.0.1", "pulled");
    await catalog.refresh();
    expect(status("demo", "1.0.1")).toBe("ineligible");
  });

  test("an integrity change after first sight refuses the version for good", async () => {
    const { npm, catalog, status, row } = setup();
    npm.publish("demo-agent", "1.0.0", { publishedAt: NOW - 72 * HOUR, integrity: sha(1) });
    await catalog.refresh();
    expect(status("demo", "1.0.0")).toBe("eligible");

    npm.replaceIntegrity("demo-agent", "1.0.0", sha(9));
    await catalog.refresh();
    expect(status("demo", "1.0.0")).toBe("refused");
    expect(row("demo", "1.0.0")?.reason).toContain("integrity of demo-agent@1.0.0 changed");
    expect(row("demo", "1.0.0")?.integrity).toBe(sha(1));

    // Putting the original integrity back does not make it eligible again.
    npm.replaceIntegrity("demo-agent", "1.0.0", sha(1));
    await catalog.refresh();
    expect(status("demo", "1.0.0")).toBe("refused");
  });

  test("an unchanged package costs one conditional request", async () => {
    const { npm, catalog, status, advance } = setup();
    npm.publish("demo-agent", "1.0.0", { publishedAt: NOW - 47 * HOUR, integrity: sha(1) });
    await catalog.refresh();
    expect(npm.requests).toEqual([{ package: "demo-agent", ifNoneMatch: null, status: 200 }]);

    advance(2 * HOUR);
    await catalog.refresh();
    expect(npm.requests.slice(1)).toEqual([
      { package: "demo-agent", ifNoneMatch: '"demo-agent-1"', status: 304 },
    ]);
    // The stored document is re-evaluated: the version is now 49 hours old.
    expect(status("demo", "1.0.0")).toBe("eligible");
  });

  test("native platform packages must be eligible at the same version", async () => {
    const { npm, catalog, status, row } = setup();
    const old = NOW - 72 * HOUR;
    const platforms = (version: string) => ({
      "demo-agent-linux-x64": version,
      "demo-agent-linux-arm64": version,
    });
    npm.publish("demo-agent", "2.0.0", {
      publishedAt: old,
      integrity: sha(1),
      optionalDependencies: platforms("2.0.0"),
    });
    npm.publish("demo-agent-linux-x64", "2.0.0", { publishedAt: old, integrity: sha(2) });
    npm.publish("demo-agent-linux-arm64", "2.0.0", { publishedAt: NOW - HOUR, integrity: sha(3) });
    npm.publish("demo-agent", "2.1.0", {
      publishedAt: old,
      integrity: sha(4),
      optionalDependencies: { "demo-agent-linux-x64": "2.0.0" },
    });
    npm.publish("demo-agent", "2.2.0", {
      publishedAt: old,
      integrity: sha(5),
      optionalDependencies: platforms("2.2.0"),
    });
    npm.publish("demo-agent-linux-x64", "2.2.0", { publishedAt: old, integrity: sha(6) });
    npm.publish("demo-agent-linux-arm64", "2.2.0", { publishedAt: old, integrity: sha(7) });
    await catalog.refresh();
    expect(status("demo", "2.0.0")).toBe("waiting");
    expect(row("demo", "2.0.0")?.reason).toContain("demo-agent-linux-arm64@2.0.0");
    expect(status("demo", "2.1.0")).toBe("ineligible");
    expect(row("demo", "2.1.0")?.reason).toContain("not at 2.1.0");
    expect(status("demo", "2.2.0")).toBe("eligible");

    npm.replaceIntegrity("demo-agent-linux-x64", "2.2.0", sha(8));
    await catalog.refresh();
    expect(status("demo", "2.2.0")).toBe("refused");
    expect(row("demo", "2.2.0")?.reason).toContain("demo-agent-linux-x64@2.2.0");
  });

  test("an adapter takes the newest eligible native version its range allows", async () => {
    const agents = { wrap: { package: "wrap-acp", native: "core-cli" } };
    const { npm, catalog, status, row } = setup(agents);
    const old = NOW - 72 * HOUR;
    npm.publish("wrap-acp", "1.0.0", {
      publishedAt: old,
      integrity: sha(1),
      dependencies: { "core-cli": "^0.5.0" },
    });
    npm.publish("wrap-acp", "1.1.0", {
      publishedAt: old,
      integrity: sha(2),
      dependencies: { "core-cli": "0.6.0" },
    });
    npm.publish("core-cli", "0.5.0", {
      publishedAt: old,
      integrity: sha(3),
      optionalDependencies: { "core-cli-linux-x64": "npm:core-cli@0.5.0-linux-x64" },
    });
    npm.publish("core-cli", "0.5.0-linux-x64", { publishedAt: old, integrity: sha(4) });
    npm.publish("core-cli", "0.5.1", { publishedAt: NOW - HOUR, integrity: sha(5) });
    npm.publish("core-cli", "0.6.0", { publishedAt: old, integrity: sha(6), deprecated: "no" });
    await catalog.refresh();
    expect(row("wrap", "1.0.0")).toMatchObject({ status: "eligible", nativeVersion: "0.5.0" });
    expect(status("wrap", "1.1.0")).toBe("ineligible");
    expect(row("wrap", "1.1.0")?.reason).toContain("core-cli@0.6.0 is deprecated");
  });

  test("a version npm no longer lists is kept but not offered", async () => {
    const { npm, catalog, status } = setup();
    npm.publish("demo-agent", "1.0.0", { publishedAt: NOW - 72 * HOUR, integrity: sha(1) });
    await catalog.refresh();
    npm.unpublish("demo-agent", "1.0.0");
    await catalog.refresh();
    expect(status("demo", "1.0.0")).toBe("ineligible");
  });

  test("a failed read never lets a waiting version pass on stored metadata", async () => {
    const { db, npm, catalog, errors, status, row } = setup();
    npm.publish("demo-agent", "1.0.0", { publishedAt: NOW - 47 * HOUR, integrity: sha(1) });
    await catalog.refresh();
    expect(status("demo", "1.0.0")).toBe("waiting");
    // npm pulls the version, but the next read fails, so only the old document is at hand.
    npm.unpublish("demo-agent", "1.0.0");
    const failing = createAgentCatalog({
      db,
      agents: DEMO,
      now: () => NOW + 24 * HOUR,
      registry: {
        fetchPackage: async () => {
          throw new Error("offline");
        },
      },
      onError: (error) => errors.push(error),
    });
    await failing.refresh();
    expect(status("demo", "1.0.0")).toBe("waiting");
    expect(row("demo", "1.0.0")?.reason).toContain("less than 48 hours");
  });

  test("a version first seen during a failed platform read waits for a fresh read", async () => {
    const { db, npm, catalog, errors, status, row } = setup();
    const old = NOW - 72 * HOUR;
    npm.publish("demo-agent-linux-x64", "3.0.0", { publishedAt: old, integrity: sha(1) });
    npm.publish("demo-agent-linux-x64", "2.9.0", { publishedAt: old, integrity: sha(3) });
    npm.publish("demo-agent", "2.9.0", {
      publishedAt: old,
      integrity: sha(4),
      optionalDependencies: { "demo-agent-linux-x64": "2.9.0" },
    });
    await catalog.refresh();
    expect(status("demo", "2.9.0")).toBe("eligible");
    npm.publish("demo-agent", "3.0.0", {
      publishedAt: old,
      integrity: sha(2),
      optionalDependencies: { "demo-agent-linux-x64": "3.0.0" },
    });
    const flaky = createAgentCatalog({
      db,
      agents: DEMO,
      now: () => NOW + HOUR,
      registry: {
        fetchPackage: (name, etag, signal) =>
          name === "demo-agent-linux-x64"
            ? Promise.reject(new Error("offline"))
            : npm.registry.fetchPackage(name, etag, signal),
      },
      onError: (error) => errors.push(error),
    });
    await flaky.refresh();
    expect(status("demo", "3.0.0")).toBe("waiting");
    expect(row("demo", "3.0.0")?.reason).toContain("could not read npm");
    await catalog.refresh();
    expect(status("demo", "3.0.0")).toBe("eligible");
  });

  test("a failed native read never moves an eligible adapter to a newer native version", async () => {
    const agents = { wrap: { package: "wrap-acp", native: "core-cli" } };
    const { db, npm, catalog, errors, row } = setup(agents);
    const old = NOW - 72 * HOUR;
    npm.publish("wrap-acp", "1.0.0", {
      publishedAt: old,
      integrity: sha(1),
      dependencies: { "core-cli": "^0.5.0" },
    });
    npm.publish("core-cli", "0.5.0", { publishedAt: old, integrity: sha(2) });
    npm.publish("core-cli", "0.5.1", { publishedAt: NOW - 47 * HOUR, integrity: sha(3) });
    await catalog.refresh();
    expect(row("wrap", "1.0.0")).toMatchObject({ status: "eligible", nativeVersion: "0.5.0" });

    // npm pulls 0.5.1, but a day later the core-cli read fails and only the cached document is left.
    npm.unpublish("core-cli", "0.5.1");
    const flaky = createAgentCatalog({
      db,
      agents,
      now: () => NOW + 24 * HOUR,
      registry: {
        fetchPackage: (name, etag, signal) =>
          name === "core-cli"
            ? Promise.reject(new Error("offline"))
            : npm.registry.fetchPackage(name, etag, signal),
      },
      onError: (error) => errors.push(error),
    });
    await flaky.refresh();
    expect(row("wrap", "1.0.0")).toMatchObject({ status: "eligible", nativeVersion: "0.5.0" });

    // A fresh read sees that 0.5.1 is gone, so 0.5.0 stays the native version.
    await createAgentCatalog({
      db,
      agents,
      now: () => NOW + 25 * HOUR,
      registry: npm.registry,
    }).refresh();
    expect(row("wrap", "1.0.0")).toMatchObject({ status: "eligible", nativeVersion: "0.5.0" });
  });

  test("a prerelease platform pin is not a platform build", async () => {
    const agents = { core: { package: "core-cli", native: "core-cli" } };
    const { npm, catalog, status, row } = setup(agents);
    const old = NOW - 72 * HOUR;
    npm.publish("core-cli", "2.0.0", {
      publishedAt: old,
      integrity: sha(1),
      optionalDependencies: {
        "core-cli-linux-x64": "2.0.0-beta.1",
        "core-cli-linux-arm64": "npm:core-cli@2.0.0-rc.1",
      },
    });
    npm.publish("core-cli-linux-x64", "2.0.0-beta.1", { publishedAt: old, integrity: sha(2) });
    npm.publish("core-cli", "2.0.0-rc.1", { publishedAt: old, integrity: sha(3) });
    npm.publish("core-cli", "2.1.0", {
      publishedAt: old,
      integrity: sha(4),
      optionalDependencies: { "core-cli-linux-x64": "npm:core-cli@2.1.0-linux-x64-musl" },
    });
    npm.publish("core-cli", "2.1.0-linux-x64-musl", { publishedAt: old, integrity: sha(5) });
    await catalog.refresh();
    expect(status("core", "2.0.0")).toBe("ineligible");
    expect(row("core", "2.0.0")?.reason).toContain("pins core-cli-linux-x64 at 2.0.0-beta.1");
    expect(status("core", "2.1.0")).toBe("eligible");
  });

  test("a failed read keeps the last catalog and reports the error", async () => {
    const { db, npm, catalog, errors } = setup();
    npm.publish("demo-agent", "1.0.0", { publishedAt: NOW - 72 * HOUR, integrity: sha(1) });
    await catalog.refresh();
    const failing = createAgentCatalog({
      db,
      agents: DEMO,
      now: () => NOW + HOUR,
      registry: {
        fetchPackage: async () => {
          throw new Error("offline");
        },
      },
      onError: (error) => errors.push(error),
    });
    await failing.refresh();
    expect(errors.map(String)).toEqual(["Error: reading demo-agent from npm failed: offline"]);
    expect(listAgentVersions(db).map((row) => [row.version, row.status])).toEqual([
      ["1.0.0", "eligible"],
    ]);
  });

  test("refreshIfDue reads the registry once a day", async () => {
    const { npm, catalog, advance } = setup();
    npm.publish("demo-agent", "1.0.0", { publishedAt: NOW - 72 * HOUR, integrity: sha(1) });
    expect(await catalog.refreshIfDue()).toBe(true);
    advance(AGENT_CATALOG_REFRESH_MS - 1);
    expect(await catalog.refreshIfDue()).toBe(false);
    advance(1);
    expect(await catalog.refreshIfDue()).toBe(true);
    expect(npm.requests).toHaveLength(2);
  });

  test("the registry document keeps publish time, integrity, deprecation and pins", () => {
    expect(
      parsePackageDocument({
        versions: {
          "1.0.0": {
            dist: { integrity: "sha512-a" },
            deprecated: "",
            dependencies: { x: "1.0.0", y: 3 },
          },
          "1.0.1": { deprecated: "gone", optionalDependencies: { z: "1.0.1" } },
          bad: "nope",
        },
        time: { "1.0.0": "2026-10-20T00:00:00.000Z", "1.0.1": "not a date" },
      }),
    ).toEqual({
      "1.0.0": {
        publishedAt: Date.parse("2026-10-20T00:00:00.000Z"),
        integrity: "sha512-a",
        deprecated: null,
        dependencies: { x: "1.0.0" },
        optionalDependencies: {},
      },
      "1.0.1": {
        publishedAt: null,
        integrity: null,
        deprecated: "gone",
        dependencies: {},
        optionalDependencies: { z: "1.0.1" },
      },
    });
  });
});

describe("agent catalog summary", () => {
  test("lists the newest eligible version and each refusal", async () => {
    const { db, npm, catalog } = setup();
    const old = NOW - 72 * HOUR;
    npm.publish("demo-agent", "1.2.0", { publishedAt: old, integrity: sha(1) });
    npm.publish("demo-agent", "1.10.0", { publishedAt: old, integrity: sha(2) });
    npm.publish("demo-agent", "1.11.0", { publishedAt: NOW - HOUR, integrity: sha(3) });
    await catalog.refresh();
    npm.replaceIntegrity("demo-agent", "1.2.0", sha(4));
    await catalog.refresh();
    expect(agentCatalogSummary(db)).toEqual([
      {
        agent: "demo",
        offered: "1.10.0",
        refused: [{ version: "1.2.0", reason: expect.stringContaining("integrity") }],
        checkedAt: NOW,
      },
    ]);
  });
});
