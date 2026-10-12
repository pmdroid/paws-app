import { expect, test } from "bun:test";
import { probeShortReads } from "./local/runner-short-reads";

test.skipIf(process.platform !== "linux")(
  "short native reads retain bounded chunks and exact job bytes",
  async () => {
    const proof = await probeShortReads();
    expect(proof.job.reads).toBeGreaterThan(250);
    expect(proof.job.allocatedBytes).toBeLessThanOrEqual(131_072);
  },
);
