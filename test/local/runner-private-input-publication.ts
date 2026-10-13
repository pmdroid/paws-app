import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerRepositories } from "./runner-repositories";

const root = mkdtempSync(join(tmpdir(), "paws-private-input-publication-"));
const observations: unknown[] = [];
await probeRunnerRepositories(
  root,
  (name, passed, observed) => observations.push({ name, passed, observed }),
  true,
);
writeFileSync(join(root, "observations.json"), JSON.stringify({ observations }, null, 2));
console.log(JSON.stringify({ root, observations }));
