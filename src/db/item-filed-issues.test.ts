import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  filedIssueOriginsSteps,
  itemFiledIssuesSteps,
  recordItemFiledIssueSteps,
  type Db,
} from "./index";
import { tempStore } from "../../test/pglite";
import { insertWorkItem } from "../../test/pglite-fixtures";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await tempStore());
  await insertWorkItem(db, "item");
  await insertWorkItem(db, "other");
});

afterEach(() => close());

const row = (linearIssueId: string, filedAt: number, itemId = "item") => ({
  itemId,
  linearIssueId,
  identifier: `PAS-${filedAt}`,
  title: `Title ${filedAt}`,
  url: filedAt === 2 ? null : `https://linear.app/x/issue/PAS-${filedAt}`,
  started: filedAt === 1,
  runId: "run",
  filedAt,
});

test("records each filed issue once and lists an item's oldest first", async () => {
  for (const value of [row("b", 2), row("a", 1), row("b", 3)])
    await db.run((q) => recordItemFiledIssueSteps(q, value));
  await db.run((q) => recordItemFiledIssueSteps(q, row("c", 4, "other")));
  expect(await db.run((q) => itemFiledIssuesSteps(q, "item"))).toEqual([row("a", 1), row("b", 2)]);
  expect(await db.run((q) => itemFiledIssuesSteps(q, "other"))).toEqual([row("c", 4, "other")]);
  expect(await db.run((q) => itemFiledIssuesSteps(q, "none"))).toEqual([]);
});

test("lists the items that filed one Linear issue, oldest first", async () => {
  await db.run((q) => recordItemFiledIssueSteps(q, row("a", 5, "other")));
  await db.run((q) => recordItemFiledIssueSteps(q, row("a", 1)));
  await db.run((q) => recordItemFiledIssueSteps(q, row("b", 2)));
  expect(await db.run((q) => filedIssueOriginsSteps(q, "a"))).toEqual([
    row("a", 1),
    row("a", 5, "other"),
  ]);
  expect(await db.run((q) => filedIssueOriginsSteps(q, "none"))).toEqual([]);
});
