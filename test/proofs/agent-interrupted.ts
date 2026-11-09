import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerBackend } from "../local/runner-backend";
import type { Proof } from "./harness";

export default {
  covers: ["src/runner-backend/**", "src/runner-worker/**", "src/runner-protocol/results.ts"],
  summary:
    "An unsolicited interrupted runner turn restarts once only after its stop checkpoint is published.",
  agent: () => [],
  async run(proof) {
    const root = mkdtempSync(join(tmpdir(), "paws-interrupted-proof-"));
    try {
      await probeRunnerBackend(root, (name, passed, observed) =>
        proof.expect(name, passed, observed),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
} satisfies Proof;
