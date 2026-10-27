import { z } from "zod";
import { jsonIn } from "./agent";
import type { BreakRef, Candidate, CandidateLink, Source } from "./types";

/** Longest distill prompt, in characters. Later sources are left out past it. */
const MAX_PROMPT_CHARS = 400_000;

const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const replySchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      decidable: z.boolean(),
      reason: z.string().optional(),
      sources: z.array(
        z.object({
          source: z.string(),
          line: z.number().int().positive().optional(),
          quote: z.string().optional(),
        }),
      ),
      breaks: z
        .array(
          z.union([
            z.object({ commit: z.string().regex(/^[0-9a-f]{7,64}$/i) }),
            z.object({ pull: z.number().int().positive() }),
          ]),
        )
        .optional(),
    }),
  ),
});

export function distillPrompt(repository: string, sources: readonly Source[]): string {
  const head = [
    `You are drafting engineering rules for ${repository} from what its team already wrote down.`,
    "Below are pull request review threads and comments, Closeout review findings, and the repository's agent docs. Each source has an id like S1. Doc lines are numbered.",
    "Group them into candidate rules. A rule is one thing a change must or must not do, that the team states or enforces more than in passing. Merge sources that state the same rule. Leave out style preferences a formatter or linter already enforces, and one-off review remarks.",
    "For each candidate decide whether a small script can decide it from the base commit and the candidate commit of a pull request alone (git diff, file contents, imports, file names). A rule that needs judgement, a running service, or a person is not decidable; say why in `reason`.",
    "When a source names a commit or a pull request that broke the rule, add it to `breaks`.",
    "Reply with only one JSON object in a ```json block:",
    '{"candidates":[{"id":"kebab-case-id","summary":"One sentence, under 200 characters.","decidable":true,"reason":"only when not decidable","sources":[{"source":"S3","line":12,"quote":"the words the source used"}],"breaks":[{"commit":"abc1234"},{"pull":42}]}]}',
    "Every candidate cites at least one source. `line` is the doc line the rule is stated on; leave it out for comments and findings. `quote` is under 160 characters.",
  ].join("\n\n");
  const parts = [head];
  let size = head.length;
  for (const source of sources) {
    const part = `## ${source.id} · ${source.kind} · ${source.title}\n${source.url}\n\n${source.text}`;
    if (size + part.length > MAX_PROMPT_CHARS) {
      parts.push(`(${sources.length - parts.length + 1} more sources were left out for length.)`);
      break;
    }
    parts.push(part);
    size += part.length;
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Candidates from the distill reply. A source id the reply invents is dropped; a candidate
 * left without a source, or whose id or summary cannot be a rule's, is not decidable.
 */
export function parseCandidates(text: string, sources: readonly Source[]): Candidate[] {
  const parsed = replySchema.safeParse(jsonIn(text));
  if (!parsed.success)
    throw new Error(`The distill reply is not the candidate list: ${parsed.error.message}`);
  const byId = new Map(sources.map((source) => [source.id, source]));
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const raw of parsed.data.candidates) {
    const links: CandidateLink[] = raw.sources.flatMap((cited) => {
      const source = byId.get(cited.source);
      if (!source) return [];
      const url = source.kind === "doc" && cited.line ? `${source.url}#L${cited.line}` : source.url;
      return [
        {
          source: source.id,
          kind: source.kind,
          url,
          quote: oneLine(cited.quote ?? docLine(source, cited.line) ?? source.title).slice(0, 160),
        },
      ];
    });
    const summary = oneLine(raw.summary);
    let reason = raw.decidable ? undefined : (raw.reason ?? "a script cannot decide it");
    if (!SLUG.test(raw.id) || raw.id.length > 64) reason = `\`${raw.id}\` is not a rule id`;
    else if (seen.has(raw.id)) reason = `\`${raw.id}\` is listed twice`;
    else if (!summary || summary.length > 200)
      reason = "the summary is not one line under 200 characters";
    else if (links.length === 0) reason = "it cites no collected source";
    seen.add(raw.id);
    candidates.push({
      id: raw.id,
      summary,
      sources: links,
      decidable: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      breaks: (raw.breaks ?? []) as BreakRef[],
    });
  }
  return candidates;
}

function docLine(source: Source, line: number | undefined): string | undefined {
  if (source.kind !== "doc" || !line) return undefined;
  const prefix = `${line}: `;
  return source.text
    .split("\n")
    .find((text) => text.startsWith(prefix))
    ?.slice(prefix.length);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
