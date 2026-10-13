import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerWorker } from "./runner-worker";
import { executeRunnerCommand } from "../../src/runner-worker";

const root = mkdtempSync(join(tmpdir(), "paws-private-input-worker-"));
const observations: unknown[] = [];
await probeRunnerWorker(
  root,
  (name, passed, observed) => observations.push({ name, passed, observed }),
  executeRunnerCommand,
  true,
);
writeFileSync(join(root, "observations.json"), JSON.stringify({ observations }, null, 2));
console.log(JSON.stringify({ root, observations }));
