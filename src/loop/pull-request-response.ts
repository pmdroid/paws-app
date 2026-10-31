import type { Database } from "bun:sqlite";
import { riskLine, type RiskClassification } from "../core";
import { getCandidateRisk, automaticRiskApprovalLine } from "../db";

/** The single PR response, posted through the usual activity gate. */
export function pullRequestReadyResponse(
  db: Database,
  input: {
    itemId: string;
    head: string;
    pull: { number: number; url?: string | null };
    risk: RiskClassification | null;
    openLine: string;
  },
): string {
  const risk = input.risk;
  let automatic = "";
  if (risk?.tier === "high") {
    const stored = getCandidateRisk(db, input.itemId, input.head);
    automatic = stored ? automaticRiskApprovalLine(db, stored) : "Manual approval required";
  }
  return [
    `Opened ${input.pull.url ?? `pull request #${input.pull.number}`}. CI checks and merging will continue in the background. Reply here to request changes.`,
    riskLine(risk),
    automatic,
    input.openLine,
  ]
    .filter(Boolean)
    .join("\n\n");
}
