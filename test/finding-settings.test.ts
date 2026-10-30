import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { findingGroupingEnabled } from "../src/db";
import { handleFindingSettingsRequest, type FindingSettingsOptions } from "../src/settings";
import { tempDb } from "./helpers";

let db: Database;
let audits: [string, string][];

beforeEach(() => {
  db = tempDb();
  db.run("INSERT INTO workspace VALUES('ws','org','Workspace',1)");
  audits = [];
});

afterEach(() => db.close());

function options(role?: string): FindingSettingsOptions {
  return {
    db,
    csrfToken: "csrf",
    workspaceId: "ws",
    groupingTime: "07:30",
    ...(role ? { role } : {}),
    audit: (action, subject) => audits.push([action, subject]),
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
  expect(findingGroupingEnabled(db, "ws")).toBe(false);
  await handleFindingSettingsRequest(post({ grouping: true }), options("admin"));
  expect(findingGroupingEnabled(db, "ws")).toBe(true);
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
  expect(findingGroupingEnabled(db, "ws")).toBe(true);
  expect(audits).toEqual([]);
});
