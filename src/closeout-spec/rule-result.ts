import { basename } from "node:path";
import type { ResolvedRule } from "./types";

/**
 * The argv a rule result records and is matched on. The probe appears by its policy path and the
 * checkout as `.`: at run time they are the trusted copy outside the checkout and the checkout's
 * own path, which differ from run to run.
 */
export function probeArgv(
  rule: Pick<ResolvedRule, "exec" | "probe">,
  base: string,
  head: string,
): string[] {
  return [...rule.exec, rule.probe, "--base", base, "--head", head, "--repo", "."];
}

/**
 * Where a rule result stores the probe that ran, relative to the evidence root. The record lists
 * it as an artifact with the probe's hash, which the evaluator compares with the policy.
 */
export function probeArtifactPath(sha256: string, probe: string): string {
  return ["probes", sha256, basename(probe)].join("/");
}
