import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const passed = loggedSessionCloseout(readSessionCloseout(path), {
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

test("a remote check carries the agent's run_closeout output and duration for the same commit", () => {
  const clear = JSON.stringify({ required: [], pending: [], blocked: null, bypassed: false });
  const root = mkdtempSync(join(tmpdir(), "paws-session-closeout-"));
  roots.push(root);
  const path = join(root, "closeout-session.json");
  const run = {
    id: "unit",
    argv: ["bun", "test"],
    exitCode: 0,
    timedOut: false,
    durationMs: 24_200,
    stdout: "\u001b[32m12 pass\u001b[0m\n",
    stderr: "warn: slow test\n",
    truncated: true,
  };
  writeSessionCloseout(path, head, clear, [run]);
  expect(readSessionCloseout(path)).toEqual({ head, report: clear, runs: [run] });
  const output: string[] = [];
  const request = {
    cwd: root,
    argv: ["bun", "test"],
    timeoutSeconds: 30,
    logFile: join(root, "unit.log"),
    artifactPath: "unit.log",
    expectedHead: head,
    onOutput: (stream: string, text: string) => output.push(`${stream}:${text}`),
  };
  const result = loggedSessionCloseout(readSessionCloseout(path), request);
  expect(result).toMatchObject({ exitCode: 0, durationMs: 24_200, truncated: true });
  expect(readFileSync(request.logFile, "utf8")).toBe(
    `STDOUT\n${run.stdout}\nSTDERR\n${run.stderr}`,
  );
  expect(output).toEqual([`stdout:${run.stdout}`, `stderr:${run.stderr}`]);

  const other = loggedSessionCloseout(readSessionCloseout(path), {
    ...request,
    expectedHead: "b".repeat(40),
    onOutput: undefined,
  });
  expect(other).toMatchObject({ exitCode: 0, durationMs: 0, truncated: false });
  expect(readFileSync(request.logFile, "utf8")).toBe(
    "STDOUT\nCloseout session report is clear.\n\nSTDERR\n",
  );

  const unfinished = JSON.stringify({ pending: ["unit"], blocked: null });
  writeSessionCloseout(path, head, unfinished, [{ ...run, exitCode: 2 }]);
  const failed = loggedSessionCloseout(readSessionCloseout(path), request);
  expect(failed).toMatchObject({ exitCode: 2, durationMs: 24_200 });
  expect(readFileSync(request.logFile, "utf8")).toContain(
    "warn: slow test\nCloseout session report is missing or unfinished.\n",
  );
});
