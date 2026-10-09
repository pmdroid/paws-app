import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DecisionDocument, GateResult } from "./types";

export interface VerdictRecorder {
  record(verdict: GateResult): Promise<void>;
}

export async function writeVerdictReport(reportDir: string, result: GateResult): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const verdictPath = path.join(reportDir, "closeout-verdict.json");
  const decisionPath = path.join(reportDir, "closeout-decision.json");
  await writeFile(verdictPath, `${JSON.stringify(result, null, 2)}\n`);
  if (result.decision) {
    await writeFile(decisionPath, `${JSON.stringify(result.decision, null, 2)}\n`);
  }
  return verdictPath;
}

export async function appendDecisionHistory(
  reportDir: string,
  entry: {
    evaluation: number;
    exitCode: number | null;
    decision: DecisionDocument | null;
    error?: string;
  },
): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  const target = path.join(reportDir, "closeout-history.jsonl");
  await appendFile(
    target,
    `${JSON.stringify({ recordedAt: new Date().toISOString(), ...entry })}\n`,
  );
}
