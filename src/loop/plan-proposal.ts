import { validateSubIssueDrafts, type FiledSubIssue, type SubIssueDraft } from "../core";
import type { QuestionOption } from "../questions";

/** The instruction for a read-only plan turn. The drafts come back as one JSON block. */
export const PLAN_PROMPT = [
  "Plan the requested work as sub-issues of this Linear issue. Do not change any files; this turn is read-only.",
  "Read the repository first, including its Closeout policy in .agents/closeout.yaml when it exists, so every sub-issue is small enough for one pull request and names how Closeout proves it done.",
  "For each sub-issue give a one-line title, a description of the change and why, and acceptance criteria. The criteria name the Closeout checks the change must pass and any visual proof (screenshots of which screens) it needs.",
  "Order the sub-issues so each one only depends on earlier ones, and list in blockedBy the zero-based positions of the earlier sub-issues that must merge first.",
  "End your final message with exactly one fenced json block in this shape, after a short summary of the plan:",
  '```json\n{"subIssues":[{"title":"...","description":"...","acceptanceCriteria":["..."],"blockedBy":[]}]}\n```',
].join("\n\n");

export type PlanResult = { summary: string; drafts: SubIssueDraft[] };

/** Read the summary and the drafts from the plan turn's final message. */
export function parsePlanResult(text: string): PlanResult {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const block = blocks.at(-1);
  const raw = block ? block[1]! : text.trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The plan did not end with a JSON block of sub-issues");
  }
  const subIssues =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { subIssues?: unknown }).subIssues
      : value;
  const drafts = validateSubIssueDrafts(subIssues);
  const summary = block ? text.slice(0, block.index).trim() : "";
  return { summary, drafts };
}

export const PLAN_CREATE = (count: number) => `Create ${count} sub-issue${count === 1 ? "" : "s"}`;
export const PLAN_EDIT = "Edit";
export const PLAN_DISCARD = "Discard";

export function planOptions(count: number): QuestionOption[] {
  return [PLAN_CREATE(count), PLAN_EDIT, PLAN_DISCARD];
}

export type PlanDecision = "create" | "discard" | "edit-ask" | "edit";

/** Create and Discard are the buttons; a bare Edit asks what to change; other text is the edit. */
export function planDecision(answer: string): PlanDecision {
  const text = answer.trim();
  if (/^create\b/i.test(text)) return "create";
  if (/^discard\b/i.test(text)) return "discard";
  if (/^edit[.!]?$/i.test(text)) return "edit-ask";
  return "edit";
}

export const PLAN_EDIT_QUESTION =
  "What should change in the proposed sub-issues? Your reply starts the next planning turn. You can also reply Create or Discard.";

/** The elicitation body: the proposal, in blocks order, then the choice. */
export function planProposalBody(identifier: string, plan: PlanResult): string {
  const lines = [
    `Proposed sub-issues for ${identifier}:`,
    ...(plan.summary ? ["", plan.summary] : []),
  ];
  for (const [index, draft] of plan.drafts.entries()) {
    lines.push("", `**${index + 1}. ${draft.title}**`);
    if (draft.blockedBy.length)
      lines.push(`Blocked by ${draft.blockedBy.map((position) => position + 1).join(", ")}.`);
    if (draft.description) lines.push("", draft.description);
    lines.push("", ...draft.acceptanceCriteria.map((line) => `- [ ] ${line}`));
  }
  lines.push(
    "",
    `Create files the sub-issues under ${identifier} in this order. Nothing is delegated. Edit takes your reply as the next planning turn; Discard files nothing.`,
  );
  return lines.join("\n");
}

/** The next turn after an edit: the proposal on the table and the requested change. */
export function planEditHandoff(drafts: readonly SubIssueDraft[], change: string): string {
  return [
    "The team asked to change the proposed sub-issues before filing them.",
    `Current proposal: ${JSON.stringify({ subIssues: drafts })}`,
    `Requested change: ${change.trim()}`,
    "Propose the complete revised list in the same JSON format.",
  ].join("\n");
}

/** The one response that ends the session after Create. */
export function planFiledResponse(identifier: string, filed: readonly FiledSubIssue[]): string {
  const links = filed.map((issue) =>
    issue.url ? `[${issue.identifier}](<${issue.url}>)` : issue.identifier,
  );
  return `Created ${filed.length} sub-issue${filed.length === 1 ? "" : "s"} under ${identifier} in blocks order: ${links.join(", ")}. Nothing was delegated; delegate the first one to start.`;
}

export const PLAN_DISCARDED = "Discarded the proposal. Nothing was filed.";
