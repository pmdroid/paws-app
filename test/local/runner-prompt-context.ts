import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerInputs } from "./runner-inputs";

const root = mkdtempSync(join(tmpdir(), "paws-runner-context-"));
const observations: unknown[] = [];
const prompt = "Restored conversation\n" + "x".repeat(20_972_002) + "日本語\nComplete final turn";
await probeRunnerInputs(
  root,
  (name, passed, observed) => observations.push({ name, passed, observed }),
  prompt,
);
writeFileSync(join(root, "observations.json"), JSON.stringify({ observations }, null, 2));
console.log(JSON.stringify({ root, observations }));
