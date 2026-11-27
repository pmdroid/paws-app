import { splitSettings, type SplitSettings } from "../config";
import type { SubIssueDraft } from "../core";
import {
  applyWorkItemEventSteps,
  approvedSplitCountSteps,
  cancelAdvancingJobsSteps,
  decideIssueSplitSteps,
  enqueueOutboxOnceSteps,
  getWorkItemSteps,
  insertIssueSplitSteps,
  issueSplitForQuestionSteps,
  markRunSteps,
  readSettingSectionsSteps,
  splitPartOfIssueSteps,
  unfiledAutoSplitSteps,
  type Db,
  type IssueSplit,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import { ulid } from "../intake";
import type { TrackerAdapter } from "../linear";
import type { StoredQuestion } from "../questions";
import { delegatorSteps, type HostTools } from "./linear-tools";
import { askSteps, restartSteps } from "./operations";

export const SPLIT_TOOL = "propose_split";

const SECTIONS = ["problem", "evidence", "change", "leaveAlone"] as const;

const text = (description: string) => ({ type: "string", description });

function definition(settings: SplitSettings) {
  return {
    name: SPLIT_TOOL,
    description: `Propose splitting this issue, when it is too big for one pull request, into at most ${settings.maxSubIssues} sub-issues in the plan-paws format. Paws files them as Linear children that block this issue and delegates them, after a person approves when the workspace asks for that. This issue then stops its own work. End your turn after a successful call.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["subIssues", "sameFiles"],
      properties: {
        sameFiles: {
          type: "boolean",
          description:
            "True when the sub-issues touch the same files: each then waits for the one before it.",
        },
        subIssues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "problem", "evidence", "change", "acceptance", "leaveAlone"],
            properties: {
              title: text("A one-line title, at most 255 characters."),
              problem: text("Problem: what is wrong or missing, and why it matters."),
              evidence: text("Evidence: files, lines, logs or measurements behind the problem."),
              change: text("Change: the decided change, and the files it touches."),
              acceptance: {
                type: "array",
                items: { type: "string" },
                description: "Acceptance: checks that prove the change done.",
              },
              leaveAlone: text("Leave alone: what this sub-issue must not change."),
            },
          },
        },
      },
    },
  };
}

function* settingsSteps(q: Q): Steps<SplitSettings> {
  return splitSettings((yield* readSettingSectionsSteps(q, ["splits"]))["splits"]);
}

export async function isSubIssue(
  store: Db,
  tracker: TrackerAdapter | null,
  item: WorkItemRecord,
): Promise<boolean> {
  if (await store.run((q) => splitPartOfIssueSteps(q, item.linearIssueId))) return true;
  if (!tracker?.readBriefIssue) return false;
  return tracker.readBriefIssue(item.linearIdentifier).then(
    (read) => read?.parent != null,
    () => true,
  );
}

export async function splitLimit(
  store: Db,
  tracker: TrackerAdapter | null,
  item: WorkItemRecord,
): Promise<number> {
  const settings = await store.run(settingsSteps);
  return tracker?.createSubIssues && settings.enabled && !(await isSubIssue(store, tracker, item))
    ? settings.maxSubIssues
    : 0;
}

export function splitDrafts(args: Record<string, unknown>, max: number): SubIssueDraft[] {
  const parts = args["subIssues"];
  if (!Array.isArray(parts) || parts.length === 0)
    throw new Error("Propose at least one sub-issue.");
  if (parts.length > max)
    throw new Error(
      `A split names at most ${max} sub-issue${max === 1 ? "" : "s"}; this one names ${parts.length}.`,
    );
  const chain = args["sameFiles"] === true;
  return parts.map((part: Record<string, unknown>, index) => {
    const missing = SECTIONS.find(
      (key) => typeof part?.[key] !== "string" || !(part[key] as string).trim(),
    );
    if (missing) throw new Error(`Sub-issue ${index + 1} needs ${missing}.`);
    const acceptance = Array.isArray(part["acceptance"])
      ? part["acceptance"].filter((line) => typeof line === "string" && line.trim())
      : [];
    if (acceptance.length === 0) throw new Error(`Sub-issue ${index + 1} needs acceptance.`);
    return {
      title: typeof part["title"] === "string" ? part["title"].trim() : "",
      description: [
        `## Problem\n\n${String(part["problem"]).trim()}`,
        `## Evidence\n\n${String(part["evidence"]).trim()}`,
        `## Change\n\n${String(part["change"]).trim()}`,
        `## Leave alone\n\n${String(part["leaveAlone"]).trim()}`,
      ].join("\n\n"),
      acceptanceCriteria: acceptance as string[],
      blockedBy: chain && index > 0 ? [index - 1] : [],
    };
  });
}

export const splitApprove = (count: number) =>
  `Split into ${count} sub-issue${count === 1 ? "" : "s"}`;
export const SPLIT_REJECT = "Keep as one issue";

export function splitQuestionBody(identifier: string, drafts: readonly SubIssueDraft[]): string {
  const lines = [`The agent proposes splitting ${identifier}:`];
  for (const [index, draft] of drafts.entries()) {
    lines.push("", `**${index + 1}. ${draft.title}**`);
    if (draft.blockedBy.length) lines.push(`Waits for ${draft.blockedBy[0]! + 1}.`);
    lines.push("", draft.description, "", ...draft.acceptanceCriteria.map((l) => `- [ ] ${l}`));
  }
  lines.push(
    "",
    `${splitApprove(drafts.length)} files them under ${identifier}, blocking it, and delegates them; ${identifier} then waits and is Done when they merge. ${SPLIT_REJECT} sends the agent back to the work. Any other reply goes to the agent as a change to the proposal.`,
  );
  return lines.join("\n");
}

export type SplitToolsInput = {
  store: Db;
  tracker: TrackerAdapter | null;
  item: WorkItemRecord;
  runId: string;
  repository: string | null;
  now: () => number;
  onProposed: (runId: string) => void;
};

export async function splitToolsFor(input: SplitToolsInput): Promise<HostTools | undefined> {
  const { store, tracker, item, runId } = input;
  const sessionId = item.sessionKey;
  if (!tracker?.createSubIssues || sessionId === null) return undefined;
  const settings = await store.run(settingsSteps);
  if (!settings.enabled) return undefined;
  let proposed = false;
  const propose = async (args: Record<string, unknown>): Promise<string> => {
    if (proposed) throw new Error("This turn already proposed a split.");
    if (await isSubIssue(store, tracker, item))
      throw new Error("This issue is a sub-issue, and a sub-issue cannot be split.");
    const drafts = splitDrafts(args, settings.maxSubIssues);
    const auto = await store.transaction(function* (q) {
      const current = yield* getWorkItemSteps(q, item.id);
      if (current?.state !== "running" || current.currentRunId !== runId)
        throw new Error("This turn is no longer current.");
      const workspaceId = (yield* delegatorSteps(q, current))?.workspaceId ?? null;
      const fresh = yield* settingsSteps(q);
      const automatic =
        (yield* approvedSplitCountSteps(q, workspaceId)) >= fresh.approvalsBeforeAuto;
      const asked = automatic
        ? null
        : yield* askSteps(
            q,
            { itemId: item.id, runId, sessionId, version: current.version },
            "split",
            splitQuestionBody(current.linearIdentifier, drafts),
            {
              options: [splitApprove(drafts.length), SPLIT_REJECT],
              reason: "split",
              now: input.now(),
            },
          );
      yield* insertIssueSplitSteps(q, {
        id: ulid(input.now()),
        itemId: item.id,
        workspaceId,
        parentIssueId: current.linearIssueId,
        parentIdentifier: current.linearIdentifier,
        repository: input.repository,
        drafts,
        questionId: asked?.question.id ?? null,
        status: automatic ? "auto" : "asked",
        createdAt: input.now(),
      });
      return automatic;
    });
    proposed = true;
    input.onProposed(runId);
    return auto
      ? "Paws files and delegates the sub-issues when this turn ends. End your turn now without further changes."
      : "The split is posted for approval. End your turn now without further changes; you will be resumed if the team wants something else.";
  };
  return {
    definitions: [definition(settings)],
    async call(name, args) {
      if (name !== SPLIT_TOOL) return { text: `Unknown tool ${name}.`, isError: true };
      try {
        return { text: await propose(args) };
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
}

function* startSplitSteps(q: Q, split: IssueSplit, item: WorkItemRecord, now: number) {
  yield* applyWorkItemEventSteps(q, item.id, "answer_completed", { now });
  if (item.currentRunId) yield* markRunSteps(q, item.currentRunId, "ended", now);
  yield* cancelAdvancingJobsSteps(q, item.id, "split", now);
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "linear.split",
    orderingKey: item.sessionKey ?? item.id,
    idempotencyKey: `split:${split.id}`,
    payload: { splitId: split.id, itemId: item.id, sessionId: item.sessionKey ?? item.id },
    now,
  });
}

export function* fileAutoSplitSteps(q: Q, itemId: string, now: number): Steps<boolean> {
  const split = yield* unfiledAutoSplitSteps(q, itemId);
  const item = yield* getWorkItemSteps(q, itemId);
  if (!split || !item || item.cancelRequested) return false;
  if (item.state !== "running" && item.state !== "awaiting_input") return false;
  yield* startSplitSteps(q, split, item, now);
  return true;
}

export function* answerSplitSteps(q: Q, question: StoredQuestion, now: number): Steps<void> {
  const split = yield* issueSplitForQuestionSteps(q, question.id);
  const item = yield* getWorkItemSteps(q, question.itemId);
  if (!split || split.status !== "asked" || !item) return;
  if (item.state !== "awaiting_input" || item.cancelRequested) return;
  const answer = (question.answer ?? "").trim().replace(/[.!]$/, "").toLowerCase();
  const approve = splitApprove(split.drafts.length).toLowerCase();
  if (answer === approve || answer === "split" || answer === "approve") {
    yield* decideIssueSplitSteps(q, split.id, "approved", question.answeredBy);
    yield* startSplitSteps(q, split, item, now);
    return;
  }
  const rejected = answer === SPLIT_REJECT.toLowerCase() || answer === "reject";
  yield* decideIssueSplitSteps(q, split.id, rejected ? "rejected" : "edited", question.answeredBy);
  yield* restartSteps(q, item, {
    reason: "answer",
    body: rejected
      ? "The team kept this issue whole and did not split it. Go on with the work as one pull request."
      : [
          "The team asked to change the proposed split before filing it.",
          `Current proposal: ${JSON.stringify(split.drafts.map(({ title }) => title))}`,
          `Requested change: ${question.answer ?? ""}`,
          `Call ${SPLIT_TOOL} again with the complete revised split, or go on with the work.`,
        ].join("\n"),
    jobKey: `split-answer:${question.id}`,
    now,
  });
}
