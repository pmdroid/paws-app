import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import {
  CloseoutResultMissingError,
  loggedSessionCloseout,
  readSessionCloseout,
  sessionCloseoutAccepted,
  sessionCloseoutResult,
  writeSessionCloseout,
} from "./session-report";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const head = "a".repeat(40);

test("a clear closeout session report accepts command checks for that commit", () => {
  const clear = JSON.stringify({
    required: [
      {
        id: "test",
        status: "passed",
        result: {
          argv: ["bun", "test"],
          head,
          exitCode: 0,
          timedOut: false,
          durationMs: 2345,
          stdout: "real test output\n",
          stderr: "diagnostic\n",
          truncated: false,
        },
      },
    ],
    pending: [],
    blocked: null,
    bypassed: false,
  });
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
  expect(passed.durationMs).toBe(2345);
  expect(readFileSync(log, "utf8")).toContain("real test output");
  expect(readFileSync(log, "utf8")).toContain("diagnostic");
  expect(passed.dirty).toBe(false);
  expect(passed.headMoved).toBe(false);
  writeSessionCloseout(path, head, undefined);
  expect(readSessionCloseout(path)).toBeUndefined();
  const missing = join(root, "missing.log");
  expect(() =>
    loggedSessionCloseout(undefined, {
      cwd: root,
      argv: ["bun", "test"],
      timeoutSeconds: 30,
      logFile: missing,
      artifactPath: "missing.log",
      expectedHead: head,
    }),
  ).toThrow(CloseoutResultMissingError);
  expect(existsSync(missing)).toBe(false);
});

test("remote command results without a match for the head, command or check never become failures", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-session-reject-"));
  roots.push(root);
  for (const patch of [
    { head: "b".repeat(40) },
    { argv: ["true"] },
    { durationMs: -1 },
    { id: "lint" },
    { status: "stale" },
  ]) {
    const { id = "test", status = "passed", ...result } = patch as Record<string, unknown>;
    const report = JSON.stringify({
      required: [
        {
          id,
          status,
          result: {
            argv: ["bun", "test"],
            head,
            exitCode: 0,
            timedOut: false,
            durationMs: 20,
            stdout: "real",
            stderr: "",
            truncated: false,
            ...result,
          },
        },
      ],
    });
    const request = {
      cwd: root,
      argv: ["bun", "test"],
      itemId: "test",
      expectedHead: head,
      timeoutSeconds: 30,
      artifactPath: "log",
      logFile: join(root, "log"),
    };
    expect(sessionCloseoutResult(report, request)).toBeUndefined();
    expect(() => loggedSessionCloseout(report, request)).toThrow(
      "Closeout checks could not run on this commit: no result for test.",
    );
  }
});
