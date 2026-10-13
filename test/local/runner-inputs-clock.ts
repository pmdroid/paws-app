import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeRunnerAuthority } from "../../src/runner-identity";
import { probeRunnerInputs } from "./runner-inputs";

export async function probeRunnerInputsClock(root: string) {
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  let beforeAuthority = 0;
  let caNotBefore = 0;
  await probeRunnerInputs(
    root,
    (name, passed, observed) => observations.push({ name, passed, observed }),
    undefined,
    async (authorityRoot) => {
      beforeAuthority = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const authority = await initializeRunnerAuthority(authorityRoot);
      caNotBefore = Date.parse(new X509Certificate(authority.certificate).validFrom);
      return authority;
    },
  );
  assert(caNotBefore > beforeAuthority);
  assert.equal(observations.length, 4);
  assert(observations.every((entry) => entry.passed));
  const result = {
    beforeAuthority,
    caNotBefore,
    elapsedPastClock: caNotBefore - beforeAuthority,
    observations,
  };
  writeFileSync(join(root, "clock-observations.json"), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-clock-"));
  console.log(JSON.stringify({ root, ...(await probeRunnerInputsClock(root)) }));
}
