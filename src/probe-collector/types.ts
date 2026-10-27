import type { RunAgentOptions, RunAgentResult } from "../acp";
import type { Finding, RuleOnFail, Severity } from "../closeout-spec";

/**
 * One agent turn. The CLI passes `runAgent` from `src/acp`, which runs the signed-in agent of
 * whoever runs it on this machine. A paired-runner backend can replace it with the same shape.
 */
export type AgentTurn = (options: RunAgentOptions) => Promise<RunAgentResult>;

export type SourceKind = "review_thread" | "pull_comment" | "closeout_finding" | "doc";

/** Something the team already wrote down, with a link back to it. */
export type Source = {
  /** `S1`, `S2`, … in collection order. The distill turn cites sources by this id. */
  id: string;
  kind: SourceKind;
  /** Where a person reads it. A doc's link names the commit it was read at. */
  url: string;
  /** One line that says what the source is, for the prompt and the output. */
  title: string;
  text: string;
  /** The pull request the comment is on. */
  pull?: number;
  /** A doc's path in the repository. */
  path?: string;
};

/** A Closeout review finding stored for one of the repository's tasks. */
export type StoredFinding = {
  task: string;
  /** The Closeout review check id. */
  check: string;
  head: string;
  finding: Finding;
};

/** A commit or pull request a source says broke the rule. */
export type BreakRef = { commit: string } | { pull: number };

/** Where a candidate came from: the source, the line a doc cites and the words it used. */
export type CandidateLink = {
  source: string;
  kind: SourceKind;
  url: string;
  quote: string;
};

export type Candidate = {
  id: string;
  /** One sentence. It becomes the rule's `summary`. */
  summary: string;
  sources: CandidateLink[];
  /** Whether a script can decide it from the base and the candidate. */
  decidable: boolean;
  /** Why a script cannot decide it, when it cannot. */
  reason?: string;
  breaks: BreakRef[];
};

/** The `rules:` entry the writing session proposed for a probe it wrote. */
export type ProposedEntry = {
  exec?: string[];
  paths?: string[];
  failOn: Severity;
  onFail?: RuleOnFail;
};

export type ProbeRun = {
  passed: boolean;
  /** What the probe printed, trimmed. */
  output: string;
};

export type BreakCheck = {
  ref: BreakRef;
  /** The commit that was checked. Null when the ref named nothing Paws could read. */
  commit: string | null;
  /** The probe's run on that commit. Null when the commit was not checked. */
  run: ProbeRun | null;
  /** Why the commit was not checked. */
  note?: string;
};

/**
 * `checked`: passes on origin/main and fails on every commit its sources name.
 * `misses_bug`: passes on a commit its sources say broke the rule.
 * `fails_on_main`: the rule may already be broken on origin/main.
 * `unverified`: passes on origin/main, and no source names a commit to check.
 */
export type CheckStatus = "checked" | "misses_bug" | "fails_on_main" | "unverified";

export type ProbeCheck = {
  main: ProbeRun;
  breaks: BreakCheck[];
  status: CheckStatus;
};

export type ProposedRule = {
  candidate: Candidate;
  entry: ProposedEntry;
  /** The path the rule's `probe:` names: `.agents/probes/<id>.ts`. */
  probe: string;
  bytes: Uint8Array;
  check: ProbeCheck;
};

export type SkippedCandidate = { candidate: Candidate; reason: string };
