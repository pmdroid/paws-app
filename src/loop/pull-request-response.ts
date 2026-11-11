import { riskLine, type RiskClassification } from "../core";
import { journalCaught } from "../journal";
import { pullRequestSummary } from "./turn-summary";

/** The single PR response, posted through the usual activity gate. */
export async function pullRequestReadyResponse(input: {
  itemId: string;
  head: string;
  pull: { number: number; url?: string | null };
  risk: RiskClassification | null;
  openLine: string;
  summary?: string;
  riskApproval?: () => Promise<string>;
  journal?: (line: string) => void;
}): Promise<string> {
  const risk = input.risk;
  let automatic = "";
  if (risk?.tier === "high") {
    automatic = "Manual approval required";
    try {
      automatic = (await input.riskApproval?.()) ?? automatic;
    } catch (error) {
      journalCaught(
        error,
        "pull-request-response.riskApproval",
        input.itemId,
        undefined,
        input.journal,
      );
    }
  }
  return [
    pullRequestSummary(input.summary),
    `Opened ${input.pull.url ?? `pull request #${input.pull.number}`}. CI checks and merging will continue in the background. Reply here to request changes.`,
    riskLine(risk),
    automatic,
    input.openLine,
  ]
    .filter(Boolean)
    .join("\n\n");
}
