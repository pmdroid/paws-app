import { expect, test } from "bun:test";
import { join } from "node:path";

test("file database fixtures survive removal of the temporary template", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "temp-root.ts"),
      "-e",
      `const { migratedDatabase, tempHome } = await import(${JSON.stringify(join(import.meta.dir, "helpers.ts"))});
const { rmSync, mkdirSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const root = tmpdir();
rmSync(root, { recursive: true });
mkdirSync(root);
const first = migratedDatabase(tempHome() + "/first.db");
first.run("CREATE TABLE fixture_only (id INTEGER)");
first.close();
const second = migratedDatabase(tempHome() + "/second.db");
if (second.query("SELECT name FROM sqlite_master WHERE name = 'fixture_only'").get()) throw new Error("fixtures share writes");
second.close();`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  expect(await child.exited, await stderr).toBe(0);
});
