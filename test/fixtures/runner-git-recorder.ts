import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(`${process.execPath}.jsonl`, `${JSON.stringify(args)}\n`, { mode: 0o600 });
const child = Bun.spawn(["/usr/bin/git", ...args], {
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
