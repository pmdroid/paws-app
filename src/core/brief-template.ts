import type { IssueBrief, WorkBrief } from "./brief";
import { acceptanceCriteriaSection, renderParentBrief, renderWorkBrief } from "./render-brief";

/**
 * Placeholders a brief template may use. `issue.id` and `issue.source` are part of today's
 * brief, so the built-in template can reproduce it. The others are the ones a member edits.
 */
export const BRIEF_PLACEHOLDERS = [
  "issue.identifier",
  "issue.title",
  "issue.description",
  "issue.acceptance_criteria",
  "issue.id",
  "issue.source",
  "parent",
  "project_overview",
  "user_updates",
  "task_context",
  "session_context",
  "conversation",
] as const;

export type BriefPlaceholder = (typeof BRIEF_PLACEHOLDERS)[number];

const PLACEHOLDER_SET = new Set<string>(BRIEF_PLACEHOLDERS);

/** Filled only while a turn is running. A preview shows a marked sample instead. */
export const BRIEF_RUN_PLACEHOLDERS = [
  "user_updates",
  "task_context",
  "session_context",
  "conversation",
] as const;

export const BRIEF_TEMPLATE_MAX = 64_000;

/** Marked stand-ins. They are not read from a session, an item, or Linear. */
export const BRIEF_RUN_SAMPLES: Record<(typeof BRIEF_RUN_PLACEHOLDERS)[number], string> = {
  user_updates: "[Sample] User update:\nThis stands in for messages the person sends during a run.",
  task_context: "[Sample] Task context filled when a turn runs.",
  session_context: "[Sample] Linear session context filled when a turn runs.",
  conversation: "[Sample] Immutable Linear conversation history:\n[]",
};

export type WorkContextInput = {
  brief: WorkBrief | null;
  projectOverview: string;
  /** Comment bodies, without the `User update:` heading. */
  userUpdates: readonly string[];
  taskContext: string;
  sessionContext: string;
  /** Linear activities already filtered the way the brief shows them. */
  activities: readonly unknown[];
};

export type BriefValues = Record<BriefPlaceholder, string>;

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/** The template Settings shows when nothing is stored. */
export function defaultBriefTemplate(): string {
  return [
    "Task brief",
    "Use the issue description and acceptance criteria as the task requirements. The delegation provides context for this child, not additional work items.",
    "Issue: {{issue.identifier}}: {{issue.title}}",
    "Source: {{issue.source}}; issue ID: {{issue.id}}",
    "Description (including acceptance criteria in the source body):\n{{issue.description}}",
    "{{issue.acceptance_criteria}}",
    "{{parent}}",
    "{{project_overview}}",
    "{{user_updates}}",
    "{{task_context}}",
    "{{session_context}}",
    "{{conversation}}",
  ].join("\n\n");
}

/** Why `template` cannot be saved, or null when it can. Names every unknown placeholder. */
export function briefTemplateProblem(template: string): string | null {
  if (template.trim() === "") return "The brief template is empty.";
  if (template.length > BRIEF_TEMPLATE_MAX)
    return `The brief template is longer than ${BRIEF_TEMPLATE_MAX.toLocaleString("en-US")} characters.`;
  if (template.includes("\0")) return "The brief template contains a null character.";
  const unknown = unknownPlaceholders(template);
  if (unknown.length === 1) return `Unknown placeholder {{${unknown[0]}}}.`;
  if (unknown.length > 1)
    return `Unknown placeholders ${unknown.map((name) => `{{${name}}}`).join(", ")}.`;
  return null;
}

export function unknownPlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]!.trim();
    if (!PLACEHOLDER_SET.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * What `workContext()` returned before templates. A stored template that is exactly the built-in
 * one takes this path, so today's bytes stay today's bytes, including a missing brief.
 */
export function legacyWorkContext(input: WorkContextInput): string {
  return [
    renderWorkBrief(input.brief),
    input.projectOverview,
    ...input.userUpdates.map((body) => `User update:\n${body}`),
    input.taskContext,
    input.sessionContext,
    input.activities.length
      ? `Immutable Linear conversation history:\n${JSON.stringify(input.activities)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function briefValues(input: WorkContextInput): BriefValues {
  const issue = input.brief?.issue;
  return {
    "issue.identifier": issue?.identifier ?? "",
    "issue.title": issue?.title ?? "",
    "issue.description": issue?.description ?? "",
    "issue.acceptance_criteria": issue ? acceptanceCriteriaSection(issue.acceptanceCriteria) : "",
    "issue.id": issue?.issueId ?? "",
    "issue.source": issue?.source ?? "",
    parent: renderParentBrief(input.brief?.epic ?? null),
    project_overview: input.projectOverview,
    user_updates: input.userUpdates.map((body) => `User update:\n${body}`).join("\n\n"),
    task_context: input.taskContext,
    session_context: input.sessionContext,
    conversation: input.activities.length
      ? `Immutable Linear conversation history:\n${JSON.stringify(input.activities)}`
      : "",
  };
}

/**
 * Render `template`. `null` and the built-in template use the legacy join. An empty placeholder
 * contributes nothing, and a block that becomes blank is left out so the blank lines around it collapse.
 * Values are inserted once: braces in issue and comment text stay text.
 */
export function renderWorkContext(template: string | null, input: WorkContextInput): string {
  if (template === null || template === defaultBriefTemplate()) return legacyWorkContext(input);
  return renderBriefTemplate(template, briefValues(input));
}

export function renderBriefTemplate(template: string, values: BriefValues): string {
  const blocks = template.replaceAll("\r\n", "\n").split("\n\n");
  return blocks
    .map((block) => substitute(block, values))
    .filter((block) => block.trim() !== "")
    .join("\n\n");
}

/** Placeholder values in the order they appear. Each name is listed once. */
export function briefSectionSizes(
  template: string,
  values: BriefValues,
): { name: string; characters: number }[] {
  const seen = new Set<string>();
  const sections: { name: string; characters: number }[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]!.trim();
    if (seen.has(name) || !PLACEHOLDER_SET.has(name)) continue;
    seen.add(name);
    sections.push({ name, characters: (values[name as BriefPlaceholder] ?? "").length });
  }
  return sections;
}

export function previewBriefValues(input: {
  issue: IssueBrief;
  parent: IssueBrief | null;
  projectOverview: string;
}): BriefValues {
  return {
    ...briefValues({
      brief: { issue: input.issue, epic: input.parent },
      projectOverview: input.projectOverview,
      userUpdates: [],
      taskContext: "",
      sessionContext: "",
      activities: [],
    }),
    ...BRIEF_RUN_SAMPLES,
  };
}

function substitute(block: string, values: BriefValues): string {
  return block.replace(PLACEHOLDER, (_whole, raw: string) => {
    const name = raw.trim();
    if (!PLACEHOLDER_SET.has(name)) throw new Error(`Unknown placeholder {{${name}}}.`);
    return values[name as BriefPlaceholder] ?? "";
  });
}
