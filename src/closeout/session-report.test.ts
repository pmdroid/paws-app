import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import {
  loggedSessionCloseout,
  readSessionCloseout,
  sessionCloseoutAccepted,
  writeSessionCloseout,
} from "./session-report";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const head = "a".repeat(40);

test("a clear closeout session report accepts command checks for that commit", () => {
  const clear = JSON.stringify({ required: [], pending: [], blocked: null, bypassed: false });
  expect(sessionCloseoutAccepted(clear)).toBe(true);
  expect(sessionCloseoutAccepted(JSON.stringify({ pending: ["test"], blocked: null }))).toBe(false);
  expect(
    sessionCloseoutAccepted(
      JSON.stringify({ pending: [], blocked: "changed paths are unavailable" }),
    ),
  ).toBe(false);
  expect(sessionCloseoutAccepted(undefined)).toBe(false);
  const root = mkdtempSync(join(tmpdir(), "paws-session-closeout-"));
  roots.push(root);
  const path = join(root, "closeout-session.json");
  writeSessionCloseout(path, head, clear);
  expect(readSessionCloseout(path)).toEqual({ head, report: clear });
  const log = join(root, "command.log");
  const passed = loggedSessionCloseout(readSessionCloseout(path)?.report, {
    cwd: root,
    argv: ["bun", "test"],
    timeoutSeconds: 30,
    logFile: log,
    artifactPath: "command.log",
    expectedHead: head,
  });
  expect(passed.exitCode).toBe(0);
  expect(passed.dirty).toBe(false);
  expect(passed.headMoved).toBe(false);
  writeSessionCloseout(path, head, undefined);
  expect(readSessionCloseout(path)).toBeUndefined();
  const failed = loggedSessionCloseout(undefined, {
    cwd: root,
    argv: ["bun", "test"],
    timeoutSeconds: 30,
    logFile: join(root, "missing.log"),
    artifactPath: "missing.log",
    expectedHead: head,
  });
  expect(failed.exitCode).toBe(1);
});
