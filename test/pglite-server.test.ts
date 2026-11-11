import { expect, test } from "bun:test";
import { SQL } from "bun";
import { pgliteServer } from "./pglite";

const SERVER = process.env.PAWS_TEST_DATABASE_URL;

async function version(url: string): Promise<string> {
  const client = new SQL({ url, max: 1 });
  try {
    const [row] = await client`SELECT version() AS version`;
    return (row as { version: string }).version;
  } finally {
    await client.close();
  }
}

test("without PAWS_TEST_DATABASE_URL the test server is PGlite", async () => {
  const server = await pgliteServer({});
  try {
    expect(await version(server.url)).toContain("emscripten");
  } finally {
    await server.close();
  }
});

test.skipIf(!SERVER)(
  "with PAWS_TEST_DATABASE_URL each test server is a fresh, migrated database there, dropped on close",
  async () => {
    const base = new URL(SERVER!);
    const first = await pgliteServer();
    const second = await pgliteServer();
    const name = new URL(first.url).pathname.slice(1);
    try {
      expect(new URL(first.url).host).toBe(base.host);
      expect(name).not.toBe(new URL(second.url).pathname.slice(1));
      expect(await version(first.url)).not.toContain("emscripten");
      expect(await first.store.run((q) => q.all(q.orm.select().from(q.t.workItem)))).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
    const admin = new SQL({ url: SERVER!, max: 1 });
    try {
      expect(await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`).toHaveLength(0);
    } finally {
      await admin.close();
    }
  },
);
