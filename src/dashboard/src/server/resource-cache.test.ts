import { describe, expect, test } from "bun:test";
import { createResourceCache, handleStatusRequest, RESOURCE_REUSE_MS } from "./handler";
import { emptyOverview } from "../live/overview";
import { migrate, openDatabase, recordPushOutage } from "../../../db";

function poll(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/api/overview", { headers });
}

describe("dashboard resource cache", () => {
  test("two polls within a second build the payload once, and a matching ETag gets 304", async () => {
    let now = 1_700_000_000_000;
    let builds = 0;
    const provider = {
      overview() {
        builds += 1;
        return emptyOverview();
      },
    };
    const resourceCache = createResourceCache({ now: () => now });
    const first = (await handleStatusRequest(poll(), { provider, resourceCache }))!;
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/".+"$/);
    const body = await first.text();
    now += RESOURCE_REUSE_MS - 1;
    const second = (await handleStatusRequest(poll(), { provider, resourceCache }))!;
    expect(await second.text()).toBe(body);
    expect(builds).toBe(1);
    const unchanged = (await handleStatusRequest(poll({ "If-None-Match": etag }), {
      provider,
      resourceCache,
    }))!;
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("ETag")).toBe(etag);
    expect(builds).toBe(1);
    now += 1;
    const stale = (await handleStatusRequest(poll({ "If-None-Match": '"other"' }), {
      provider,
      resourceCache,
    }))!;
    expect(stale.status).toBe(200);
    expect(builds).toBe(2);
  });

  test("polls that arrive while the payload builds wait for that build", async () => {
    let builds = 0;
    const ready = Promise.withResolvers<void>();
    const provider = {
      async overview() {
        builds += 1;
        await ready.promise;
        return emptyOverview();
      },
    };
    const resourceCache = createResourceCache();
    const polls = [1, 2, 3].map(() => handleStatusRequest(poll(), { provider, resourceCache }));
    ready.resolve();
    expect((await Promise.all(polls)).map((response) => response!.status)).toEqual([200, 200, 200]);
    expect(builds).toBe(1);
  });

  test("each reader gets its own payload, and a failed build is not reused", async () => {
    let builds = 0;
    let fail = true;
    const provider = {
      overview() {
        builds += 1;
        if (fail) throw new Error("database is locked");
        return emptyOverview();
      },
    };
    const resourceCache = createResourceCache();
    const failed = await handleStatusRequest(poll(), { provider, resourceCache });
    expect(failed!.status).toBe(500);
    fail = false;
    await handleStatusRequest(poll(), { provider, resourceCache, sessionIds: ["a"] });
    await handleStatusRequest(poll(), { provider, resourceCache, sessionIds: ["b"] });
    await handleStatusRequest(poll(), { provider, resourceCache, sessionIds: ["a"] });
    expect(builds).toBe(3);
  });

  test("without a cache every poll builds the payload", async () => {
    let builds = 0;
    const provider = {
      overview() {
        builds += 1;
        return emptyOverview();
      },
    };
    await handleStatusRequest(poll(), { provider });
    await handleStatusRequest(poll(), { provider });
    expect(builds).toBe(2);
  });

  test("a reader's scope never replays another reader's diagnostics", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('w','org','W',0)",
    );
    for (const team of ["a", "b"]) {
      db.run("INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('w',?,?)", [
        `fixture/team-${team}`,
        team,
      ]);
      db.run(
        `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
          installation_observed_at, created_at) VALUES (?, 'org', 'fixture', 'app', ?, 1, 0)`,
        [`s-${team}`, team],
      );
      recordPushOutage(db, {
        repository: `fixture/team-${team}`,
        error: "denied",
        jobId: null,
        installationUrl: null,
        now: 0,
        delayMs: () => 60_000,
      });
    }
    const resourceCache = createResourceCache({ now: () => 0 });
    const read = async (sessionIds: string[]) => {
      const response = await handleStatusRequest(poll(), { db, resourceCache, sessionIds });
      const body = (await response!.json()) as { pushOutages: Array<{ repository: string }> };
      return body.pushOutages.map((outage) => outage.repository).sort();
    };
    for (let round = 0; round < 2; round += 1) {
      expect(await read(["s-a", "s-b"])).toEqual(["fixture/team-a", "fixture/team-b"]);
      expect(await read(["s-a"])).toEqual(["fixture/team-a"]);
    }
    expect(await read([])).toEqual([]);
    db.close();
  });
});
