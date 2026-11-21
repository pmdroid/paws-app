import { riskLine, type RiskClassification } from "../core";
import { journalCaught } from "../journal";
import { publicToolText } from "./activity";
import { pullRequestSummary } from "./turn-summary";

export type FiledFollowUp = {
  identifier: string;
  title: string;
  url: string | null;
  started: boolean;
};

const FOLLOW_UP_LINES = 10;

function followUpsParagraph(filed: readonly FiledFollowUp[]): string {
  if (!filed.length) return "";
  const lines = filed.slice(0, FOLLOW_UP_LINES).map((issue) => {
    const name = issue.url ? `[${issue.identifier}](${issue.url})` : issue.identifier;
    return `- ${name}: ${publicToolText(issue.title)}${issue.started ? " (handed to Paws)" : ""}`;
  });
  const more = filed.length - FOLLOW_UP_LINES;
  return [
    "Follow-ups filed from this work:",
    ...lines,
    ...(more > 0 ? [`and ${more} more.`] : []),
  ].join("\n");
}

/** The single PR response, posted through the usual activity gate. */
export async function pullRequestReadyResponse(input: {
  itemId: string;
  head: string;
  pull: { number: number; url?: string | null };
  risk: RiskClassification | null;
  openLine: string;
  filed: readonly FiledFollowUp[];
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
    followUpsParagraph(input.filed),
    riskLine(risk),
    automatic,
    input.openLine,
  ]
    .filter(Boolean)
    .join("\n\n");
}
