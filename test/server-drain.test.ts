import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { startPaws } from "../src/index";
import { tempHome } from "./helpers";
import { startServer } from "../src/server";

test("HTTP shutdown drains an accepted artifact read before SQLite closes", async () => {
  const db = openDatabase(":memory:");
  db.run("CREATE TABLE drain_proof(value TEXT)");
  db.run("INSERT INTO drain_proof VALUES('complete')");
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let readCompleted = false;
  let error: string | null = null;
  let closed = false;
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db,
    webhooks: false,
    readLinearArtifact: async () => {
      entered.resolve();
      await gate.promise;
      try {
        readCompleted =
          db.query<{ value: string }, []>("SELECT value FROM drain_proof").get()?.value ===
          "complete";
      } catch (caught) {
        error = String(caught);
      } finally {
        completed.resolve();
      }
      return { bytes: new Uint8Array([1]), mimeType: "image/png", displayName: "Proof.png" };
    },
  });
  const request = fetch(
    `http://127.0.0.1:${server.port}/api/linear/artifacts/bac3f259-220f-4671-a193-42c764c92f23`,
  ).catch(() => null);
  try {
    await entered.promise;
    let stopped = false;
    const stopping = Promise.resolve(server.stop(true)).then(() => {
      db.close();
      closed = true;
      stopped = true;
    });
    await Bun.sleep(10);
    const waited = !stopped;
    gate.resolve();
    await Promise.all([stopping, completed.promise, request]);
    expect({ waited, readCompleted, error }).toEqual({
      waited: true,
      readCompleted: true,
      error: null,
    });
  } finally {
    gate.resolve();
    await server.stop(true);
    await request;
    if (!closed) db.close();
  }
});

test("Paws shutdown joins an accepted HTTP operation before closing SQLite", async () => {
  const home = tempHome();
  writeFileSync(join(home, "config.toml"), "[linear]\n");
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("StartLinearSession")) {
        entered.resolve();
        await gate.promise;
        throw new Error("Offline session creation ended.");
      }
      if (query.includes("agentSessions"))
        return Response.json({
          data: { agentSessions: { nodes: [], pageInfo: { hasNextPage: false } } },
        });
      throw new Error("Unexpected offline Linear request.");
    },
    { preconnect: () => undefined },
  );
  const paws = startPaws({
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_NO_TUNNEL: "1",
    LINEAR_ACCESS_TOKEN: "offline-token",
  });
  const origin = `http://127.0.0.1:${paws.server.port}`;
  let request: Promise<Response | null> | undefined;
  try {
    const page = await (await nativeFetch(`${origin}/status/`)).text();
    const csrf = page.match(/name="paws-csrf" content="([^"]+)"/)?.[1];
    expect(csrf).toBeDefined();
    request = nativeFetch(`${origin}/api/linear/sessions`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-paws-csrf": csrf! },
      body: JSON.stringify({ target: "ENG-1" }),
    }).catch(() => null);
    await entered.promise;
    let stopped = false;
    const stopping = paws.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    let databaseOpen = false;
    try {
      databaseOpen = paws.db.query<{ alive: number }, []>("SELECT 1 AS alive").get()?.alive === 1;
    } catch {}
    const waited = !stopped;
    gate.resolve();
    await Promise.all([stopping, request]);
    expect({ waited, databaseOpen }).toEqual({ waited: true, databaseOpen: true });
    expect(() => paws.db.query("SELECT 1").get()).toThrow();
  } finally {
    gate.resolve();
    await paws.stop();
    await request;
    globalThis.fetch = nativeFetch;
  }
});
