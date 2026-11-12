import { afterEach, beforeEach, expect, test } from "bun:test";
import { findingGroupingEnabled, type Db } from "../src/db";
import { handleFindingSettingsRequest, type FindingSettingsOptions } from "../src/settings";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

let db: Db;
let close: () => Promise<void>;
let audits: [string, string][];

beforeEach(async () => {
  ({ db, close } = await tempStore());
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 1 }),
  );
  audits = [];
});

afterEach(() => close());

function options(role?: string): FindingSettingsOptions {
  return {
    store: db,
    csrfToken: "csrf",
    workspaceId: "ws",
    groupingTime: "07:30",
    ...(role ? { role } : {}),
    audit: async (action, subject) => {
      audits.push([action, subject]);
    },
  };
}

const url = "http://127.0.0.1:8787/api/settings/findings";
function post(body: unknown, csrf = "csrf"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-paws-csrf": csrf },
    body: JSON.stringify(body),
  });
}

test("grouping starts on and an admin can switch it off and on", async () => {
  const listed = await handleFindingSettingsRequest(new Request(url), options("admin"));
  expect(await listed!.json()).toEqual({ grouping: true, groupingTime: "07:30" });
  const off = await handleFindingSettingsRequest(post({ grouping: false }), options("admin"));
  expect(off!.status).toBe(200);
  expect(await off!.json()).toMatchObject({ grouping: false });
  expect(await findingGroupingEnabled(db, "ws")).toBe(false);
  await handleFindingSettingsRequest(post({ grouping: true }), options("admin"));
  expect(await findingGroupingEnabled(db, "ws")).toBe(true);
  expect(audits).toEqual([
    ["settings.findings.grouping", "Turned daily finding grouping off"],
    ["settings.findings.grouping", "Turned daily finding grouping on"],
  ]);
});

test("members, missing CSRF and malformed bodies cannot change grouping", async () => {
  expect(
    (await handleFindingSettingsRequest(post({ grouping: false }), options("member")))!.status,
  ).toBe(403);
  expect(
    (await handleFindingSettingsRequest(post({ grouping: false }, "wrong"), options("admin")))!
      .status,
  ).toBe(403);
  expect(
    (await handleFindingSettingsRequest(post({ grouping: "no" }), options("admin")))!.status,
  ).toBe(400);
  expect(await findingGroupingEnabled(db, "ws")).toBe(true);
  expect(audits).toEqual([]);
});
