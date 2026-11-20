import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeRepositoryDescriptionSteps, type Db } from "../src/db";
import {
  REPOSITORY_DESCRIPTIONS_PATH,
  handleRepositoryDescriptionSettingsRequest,
  type RepositoryDescriptionSettingsOptions,
} from "../src/settings";
import { seed } from "./pglite-fixtures";
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
  await seed(db, (q) =>
    q.orm.insert(q.t.workspaceRepository).values([
      { workspaceId: "ws", repository: "acme/api", teamId: "t" },
      { workspaceId: "ws", repository: "acme/web", teamId: "t" },
    ]),
  );
  audits = [];
});

afterEach(() => close());

function options(role?: string): RepositoryDescriptionSettingsOptions {
  return {
    store: db,
    csrfToken: "csrf",
    workspaceId: "ws",
    now: () => 50,
    ...(role ? { role } : {}),
    audit: async (action, subject) => {
      audits.push([action, subject]);
    },
  };
}

function call(method: string, body?: unknown, role?: string, token = "csrf") {
  return handleRepositoryDescriptionSettingsRequest(
    new Request(`http://127.0.0.1${REPOSITORY_DESCRIPTIONS_PATH}`, {
      method,
      headers: { "content-type": "application/json", "x-paws-csrf": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    options(role),
  ) as Promise<Response>;
}

async function listed() {
  return ((await (await call("GET")).json()) as { repositories: unknown[] }).repositories;
}

test("an admin description is listed, survives a paws write and is cleared", async () => {
  await db.transaction((q) =>
    writeRepositoryDescriptionSteps(q, {
      workspaceId: "ws",
      repository: "acme/web",
      text: "The web app.",
      source: "paws",
      contentHash: "h",
      now: 10,
    }),
  );
  expect(await listed()).toEqual([
    { repository: "acme/api", text: null, source: null, updatedAt: null },
    { repository: "acme/web", text: "The web app.", source: "paws", updatedAt: 10 },
  ]);

  const put = await call("PUT", { repository: "Acme/API", text: "The public API." }, "admin");
  expect(put.status).toBe(200);
  await db.transaction((q) =>
    writeRepositoryDescriptionSteps(q, {
      workspaceId: "ws",
      repository: "acme/api",
      text: "Paws's guess.",
      source: "paws",
      contentHash: "h",
      now: 60,
    }),
  );
  expect((await listed())[0]).toEqual({
    repository: "acme/api",
    text: "The public API.",
    source: "admin",
    updatedAt: 50,
  });

  expect((await call("DELETE", { repository: "acme/api" })).status).toBe(200);
  expect((await listed())[0]).toEqual({
    repository: "acme/api",
    text: null,
    source: null,
    updatedAt: null,
  });
  expect(audits).toEqual([
    ["settings.repository-description", "Saved the description of acme/api"],
    ["settings.repository-description", "Cleared the description of acme/api"],
  ]);
});

test("a non-admin, a missing token, an unknown repository and a bad text are refused", async () => {
  expect((await call("GET", undefined, "member")).status).toBe(403);
  expect((await call("PUT", { repository: "acme/api", text: "x" }, "member")).status).toBe(403);
  expect((await call("PUT", { repository: "acme/api", text: "x" }, "admin", "")).status).toBe(403);
  expect((await call("DELETE", { repository: "acme/api" }, "admin", "")).status).toBe(403);
  expect((await call("PUT", { repository: "acme/other", text: "x" })).status).toBe(404);
  expect((await call("DELETE", { repository: "acme/other" })).status).toBe(404);
  expect((await call("PUT", { repository: "acme/api", text: "x".repeat(301) })).status).toBe(400);
  expect((await call("PUT", { repository: "acme/api", text: "  " })).status).toBe(400);
  expect((await call("POST", { repository: "acme/api" })).status).toBe(405);
  expect(await listed()).toEqual([
    { repository: "acme/api", text: null, source: null, updatedAt: null },
    { repository: "acme/web", text: null, source: null, updatedAt: null },
  ]);
  expect(audits).toEqual([]);
});
