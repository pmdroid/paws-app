import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleRoots } from "./temp-root.ts";

test("tests commit with the same git identity on every machine", () => {
  const repo = mkdtempSync(join(tmpdir(), "git-identity-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  const ident = Bun.spawnSync(["git", "-C", repo, "var", "GIT_AUTHOR_IDENT"], {
    env: { ...process.env, HOME: repo },
  });
  expect(ident.stdout.toString()).toStartWith("Paws Test <test@paws.invalid>");
});

test("the sweep removes roots of dead processes and old roots without a pid", () => {
  const parent = mkdtempSync(join(tmpdir(), "sweep-"));
  const dead = Bun.spawnSync(["true"]).pid;
  const roots = { dead: "pt-dead", live: "pt-live", old: "pt-old", recent: "pt-recent" };
  for (const name of Object.values(roots)) mkdirSync(join(parent, name));
  writeFileSync(join(parent, roots.dead, ".pid"), String(dead));
  writeFileSync(join(parent, roots.live, ".pid"), String(process.pid));
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(join(parent, roots.old), sevenHoursAgo, sevenHoursAgo);

  sweepStaleRoots(parent);

  expect(existsSync(join(parent, roots.dead))).toBe(false);
  expect(existsSync(join(parent, roots.old))).toBe(false);
  expect(existsSync(join(parent, roots.live))).toBe(true);
  expect(existsSync(join(parent, roots.recent))).toBe(true);
});

test("a root is removed when its process receives SIGTERM", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "temp-root.ts"),
      "-e",
      "console.log(process.env.TMPDIR); setInterval(() => {}, 1000);",
    ],
    { stdout: "pipe" },
  );
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  const root = new TextDecoder().decode(value).trim();
  expect(existsSync(join(root, ".pid"))).toBe(true);

  child.kill("SIGTERM");

  expect(await child.exited).toBe(143);
  expect(existsSync(root)).toBe(false);
});
