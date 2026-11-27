import { afterEach, expect, test } from "bun:test";
import { RUNNER_LEASE_GRACE_MS } from "../runner-protocol";
import { releaseTestPermit, takeTestPermit, TEST_PERMIT_TTL_MS, type Db } from "./index";
import { withoutForeignKeys } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";
import { seedWork } from "../../test/runner-rows";

const NOW = 1_000_000;
const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});

async function store(work: Record<string, { runnerId: string; leaseUntil?: number }>) {
  const { db, close } = await tempStore();
  closes.push(close);
  await withoutForeignKeys(db);
  for (const [runId, { runnerId, leaseUntil }] of Object.entries(work))
    await seedWork(db, runId, runnerId, leaseUntil === undefined ? {} : { leaseUntil });
  return db;
}

const take = (db: Db, runId: string, runnerId = "r1", now = NOW) =>
  takeTestPermit(db, { runId, runnerId, now });

test("two test checks on one runner take the permit one after the other, in order", async () => {
  const db = await store({
    a: { runnerId: "r1" },
    b: { runnerId: "r1" },
    c: { runnerId: "r1" },
  });
  expect(await take(db, "a")).toEqual({ granted: true });
  expect(await take(db, "b", "r1", NOW + 1)).toMatchObject({ granted: false, holder: "a" });
  expect(await take(db, "c", "r1", NOW + 2)).toMatchObject({ granted: false, holder: "a" });
  expect(await take(db, "a")).toEqual({ granted: true });
  await releaseTestPermit(db, "a");
  expect(await take(db, "c", "r1", NOW + 3)).toMatchObject({ granted: false, holder: null });
  expect(await take(db, "b", "r1", NOW + 4)).toEqual({ granted: true });
  expect(await take(db, "c", "r1", NOW + 5)).toMatchObject({ granted: false, holder: "b" });
  await releaseTestPermit(db, "b");
  expect(await take(db, "c", "r1", NOW + 6)).toEqual({ granted: true });
});

test("test checks on different runners hold permits at the same time", async () => {
  const db = await store({ a: { runnerId: "r1" }, b: { runnerId: "r2" } });
  expect(await take(db, "a", "r1")).toEqual({ granted: true });
  expect(await take(db, "b", "r2")).toEqual({ granted: true });
});

test("concurrent takes grant the permit once", async () => {
  const db = await store({ a: { runnerId: "r1" }, b: { runnerId: "r1" } });
  const results = await Promise.all([take(db, "a"), take(db, "b")]);
  expect(results.filter((result) => result.granted)).toHaveLength(1);
});

test("an expired holder lease frees the permit", async () => {
  const db = await store({ a: { runnerId: "r1", leaseUntil: NOW + 1_000 }, b: { runnerId: "r1" } });
  expect(await take(db, "a")).toEqual({ granted: true });
  expect(await take(db, "b")).toMatchObject({ granted: false, holder: "a" });
  const later = NOW + Math.max(1_000 + RUNNER_LEASE_GRACE_MS, TEST_PERMIT_TTL_MS) + 1;
  expect(await take(db, "b", "r1", later)).toEqual({ granted: true });
});

test("a run placed but not yet assigned holds its place until its permit row expires", async () => {
  const db = await store({});
  expect(await take(db, "a")).toEqual({ granted: true });
  expect(await take(db, "b", "r1", NOW + 1)).toMatchObject({ granted: false, holder: "a" });
  expect(await take(db, "a", "r1", NOW + TEST_PERMIT_TTL_MS - 1)).toEqual({ granted: true });
  expect(await take(db, "b", "r1", NOW + TEST_PERMIT_TTL_MS + 1)).toMatchObject({
    holder: "a",
  });
  expect(await take(db, "b", "r1", NOW + 2 * TEST_PERMIT_TTL_MS)).toEqual({ granted: true });
});

test("a waiter keeps its first request time across takes", async () => {
  const db = await store({ a: { runnerId: "r1" }, b: { runnerId: "r1" } });
  await take(db, "a");
  expect(await take(db, "b", "r1", NOW + 5)).toMatchObject({ requestedAt: NOW + 5 });
  expect(await take(db, "b", "r1", NOW + 60_000)).toMatchObject({ requestedAt: NOW + 5 });
});
