import { expect, test } from "bun:test";
import { listRepositoryCatalog, type CatalogEntry } from "../src/db";
import { createRepositoryCatalogRefresh } from "../src/server";
import { tempDb } from "./helpers";

function entry(repo: string): CatalogEntry {
  return {
    owner: "acme",
    repo,
    remoteUrl: `https://github.com/acme/${repo}.git`,
    defaultBranch: "main",
  };
}

function scriptedList() {
  let installed: CatalogEntry[] = [];
  const calls: { seen: string[]; release: (failure?: Error) => void }[] = [];
  const started: (() => void)[] = [];
  let observed = 0;
  return {
    calls,
    install(entries: CatalogEntry[]) {
      installed = entries;
    },
    next() {
      const index = observed++;
      return new Promise<(typeof calls)[number]>((resolve) => {
        const check = () => (calls[index] ? resolve(calls[index]!) : started.push(check));
        check();
      });
    },
    list() {
      const snapshot = installed;
      const held = Promise.withResolvers<CatalogEntry[]>();
      calls.push({
        seen: snapshot.map((value) => value.repo),
        release: (failure) => (failure ? held.reject(failure) : held.resolve(snapshot)),
      });
      for (const waiting of started.splice(0)) waiting();
      return held.promise;
    },
  };
}

const repos = (db: ReturnType<typeof tempDb>) =>
  listRepositoryCatalog(db).map((value) => value.repo);

test("refreshes requested during a listing coalesce into one follow-up that reads replaced and revoked installations", async () => {
  const db = tempDb();
  const abort = new AbortController();
  try {
    const github = scriptedList();
    const catalog = createRepositoryCatalogRefresh(db, () => github.list(), abort.signal);
    github.install([entry("old")]);
    const first = catalog.refresh();
    const listingOld = await github.next();
    github.install([entry("replacement")]);
    const replaced = catalog.refresh();
    const again = catalog.refresh();
    expect(github.calls).toHaveLength(1);
    listingOld.release();
    expect(await first).toBe(false);
    expect(repos(db)).toEqual([]);
    const listingReplacement = await github.next();
    expect(listingReplacement.seen).toEqual(["replacement"]);
    github.install([]);
    const revoked = catalog.refresh();
    listingReplacement.release();
    expect(await replaced).toBe(false);
    expect(await again).toBe(false);
    expect(repos(db)).toEqual([]);
    const listingRevoked = await github.next();
    expect(listingRevoked.seen).toEqual([]);
    listingRevoked.release();
    expect(await revoked).toBe(true);
    expect(repos(db)).toEqual([]);
    expect(github.calls).toHaveLength(3);
    await catalog.stopped();
  } finally {
    abort.abort();
    db.close();
  }
});

test("a failed refresh reports false, keeps the last catalog and a later request retries", async () => {
  const db = tempDb();
  const abort = new AbortController();
  try {
    const github = scriptedList();
    const catalog = createRepositoryCatalogRefresh(db, () => github.list(), abort.signal);
    github.install([entry("widgets")]);
    const seeded = catalog.refresh();
    (await github.next()).release();
    expect(await seeded).toBe(true);
    github.install([entry("gadgets")]);
    const failing = catalog.refresh();
    (await github.next()).release(new Error("GitHub is down"));
    expect(await failing).toBe(false);
    expect(repos(db)).toEqual(["widgets"]);
    const retried = catalog.refresh();
    (await github.next()).release();
    expect(await retried).toBe(true);
    expect(repos(db)).toEqual(["gadgets"]);
  } finally {
    abort.abort();
    db.close();
  }
});

test("shutdown discards an in-flight listing, refuses new refreshes and joins before the database closes", async () => {
  const db = tempDb();
  const abort = new AbortController();
  let closed = false;
  try {
    const github = scriptedList();
    const catalog = createRepositoryCatalogRefresh(db, () => github.list(), abort.signal);
    github.install([entry("widgets")]);
    const inFlight = catalog.refresh();
    const queued = catalog.refresh();
    const listing = await github.next();
    abort.abort();
    expect(await catalog.refresh()).toBe(false);
    let joined = false;
    const stopped = catalog.stopped().then(() => {
      joined = true;
    });
    await Bun.sleep(5);
    expect(joined).toBe(false);
    listing.release();
    expect(await inFlight).toBe(false);
    expect(await queued).toBe(false);
    await stopped;
    expect(repos(db)).toEqual([]);
    expect(github.calls).toHaveLength(1);
    db.close();
    closed = true;
    expect(await catalog.refresh()).toBe(false);
    expect(github.calls).toHaveLength(1);
  } finally {
    abort.abort();
    if (!closed) db.close();
  }
});

for (const change of ["replace", "revoke"] as const)
  test(`a ${change}d generation discards a held listing and reads current credentials without another request`, async () => {
    const db = tempDb();
    const abort = new AbortController();
    const github = scriptedList();
    const catalog = createRepositoryCatalogRefresh(db, () => github.list(), abort.signal);
    try {
      db.run("INSERT INTO workspace VALUES ('workspace','org','Workspace',0)");
      db.run(
        "INSERT INTO workspace_github_connection(workspace_id,generation,secret_id,installation_id) VALUES ('workspace',1,'old','22')",
      );
      github.install([entry("old")]);
      const old = catalog.refresh();
      const listing = await github.next();
      db.run(
        "UPDATE workspace_github_connection SET generation=2,secret_id=?,installation_id=?",
        change === "replace" ? ["replacement", "23"] : [null, null],
      );
      github.install(change === "replace" ? [entry("current")] : []);
      const followUp = github.next();
      listing.release();
      expect(await old).toBe(false);
      expect(repos(db)).toEqual([]);
      const current = await followUp;
      current.release();
      await catalog.stopped();
      expect(repos(db)).toEqual(change === "replace" ? ["current"] : []);
      expect(github.calls).toHaveLength(2);
    } finally {
      abort.abort();
      await catalog.stopped();
      db.close();
    }
  });

test("a failed catalog publication rolls back deletion and reports false before retry", async () => {
  const db = tempDb();
  const abort = new AbortController();
  let entries = [entry("old")];
  const catalog = createRepositoryCatalogRefresh(db, async () => entries, abort.signal);
  try {
    expect(await catalog.refresh()).toBe(true);
    db.run(
      "CREATE TRIGGER refuse_catalog BEFORE INSERT ON repository_catalog BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END",
    );
    entries = [entry("new")];
    expect(await catalog.refresh()).toBe(false);
    expect(repos(db)).toEqual(["old"]);
    db.run("DROP TRIGGER refuse_catalog");
    expect(await catalog.refresh()).toBe(true);
    expect(repos(db)).toEqual(["new"]);
  } finally {
    abort.abort();
    await catalog.stopped();
    db.close();
  }
});
