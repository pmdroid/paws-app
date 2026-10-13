import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerTaskAuthority } from "./runner-task-authority";

const root = mkdtempSync(join(tmpdir(), "paws-input-download-"));
const observations: unknown[] = [];
await probeRunnerTaskAuthority(
  root,
  (name, passed, observed) => observations.push({ name, passed, observed }),
  true,
);
writeFileSync(join(root, "observations.json"), JSON.stringify({ observations }, null, 2));
console.log(JSON.stringify({ root, observations }));
