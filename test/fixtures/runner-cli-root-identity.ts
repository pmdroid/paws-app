/**
 * Preloaded before `src/runner-cli/main.ts` so `runner enroll` can start without root or the
 * runner accounts. Only the identity lookups are replaced; the files are read for real.
 */
import { mock } from "bun:test";
import * as childProcess from "node:child_process";

const uid = process.getuid!() || 17_001;
void mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: (file: string) => (file === "/usr/bin/id" ? `${uid}\n` : `group:x:${uid}:\n`),
}));
process.getuid = () => 0;
