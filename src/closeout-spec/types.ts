/**
 * Frozen Closeout draft 0.1 types.
 *
 * Paws evaluates the closeout.fyi specification in process. These types are the
 * shared seam for that work: policy documents, the resolved policy, evidence
 * records, the decision document, and the ports a loader, runner, reviewer,
 * and evaluator implement. This file does not load YAML, hash a policy, spawn
 * a process, or decide acceptance.
 *
 * The prose contract is `spec/0.1.md` in `pmdroid/closeout` at `SPEC_COMMIT`
 * (`baac33e8715aac9d646796035ecc9ba7aaee02ef`). JSON Schema for the three
 * on-disk documents is vendored in `schema/` and pinned by `schema/manifest.json`.
 *
 * Field names match the schema and the canonical policy JSON. Ids and import
 * names match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`. A qualified id after import is
 * `prefix/id` and may contain slashes.
 */

/** Draft this module implements. A later edition uses a new value. */
export const SPEC_VERSION = "0.1" as const;

/**
 * `pmdroid/closeout` commit whose `schema/*.schema.json` and `spec/0.1.md`
 * these types follow. Short id; the full id is `baac33e8715aac9d646796035ecc9ba7aaee02ef`.
 */
export const SPEC_COMMIT = "baac33e" as const;

export type SpecVersion = typeof SPEC_VERSION;

/** The only gate in this edition. */
export type Gate = "beforePR";

/** Most severe first: `P0`, `P1`, `P2`, `P3`. */
export type Severity = "P0" | "P1" | "P2" | "P3";

export type RetryScope = "task" | "candidate";

/**
 * Present only on the entry policy. Both fields are required together.
 * Counts attempts whose evaluated state is `failed`, including the first.
 * Passed, missing, stale, invalid, untrusted, and independence records do not
 * count. Once the limit is reached the item state is `exhausted`, acceptance
 * is `blocked`, and further attempts for that requirement are refused.
 */
export type RetryPolicy = {
  /** Integer from 1 to 100000. */
  maxFailedAttemptsPerItem: number;
  /**
   * `candidate` shares `itemId`, `policyDigest`, `base`, and `head`.
   * `task` shares `itemId`, `policyDigest`, and `task` across every base and head.
   * Task scope requires a nonblank task id of at most 256 bytes.
   */
  scope: RetryScope;
};

/**
 * `true` means the reviewer's value and the candidate's value are both
 * non-empty and different. An empty or unknown value does not satisfy `true`.
 */
export type Independence = {
  differentSession: boolean;
  differentModel: boolean;
};

export type PolicyImport = {
  /** Repository-root-relative path of another policy file. */
  path: string;
  /** Namespace segment. The child prefix is `as`, or `parent/as` when nested. */
  as: string;
};

/** `paths` omitted means the requirement always applies. An empty list is invalid. */
export type PolicyPaths = string[];

export type PolicyCommand = {
  id: string;
  kind: "command";
  gate: Gate;
  /** Argv. The runner does not invoke a shell. 1 to 32 strings. */
  exec: string[];
  /** Integer from 1 to 86400. */
  timeoutSeconds: number;
  paths?: PolicyPaths;
};

export type PolicyReview = {
  id: string;
  kind: "review";
  gate: Gate;
  /** Repository-root-relative path ending in `/SKILL.md`. The file must exist. */
  skill: string;
  independence: Independence;
  /**
   * A finding fails the requirement when its severity is this rank or more severe.
   * `P1` fails on `P0` and `P1`.
   */
  failOn: Severity;
  paths?: PolicyPaths;
};

/** Unknown kinds are not in `policy.schema.json`. See `ResolvedUnsupported`. */
export type PolicyItem = PolicyCommand | PolicyReview;

/**
 * Entry document only. An imported file that contains `setup` does not load.
 * The array, when present, has 1 to 32 steps.
 */
export type PolicySetupStep = {
  id: string;
  exec: string[];
  timeoutSeconds: number;
  paths?: PolicyPaths;
};

/**
 * One YAML 1.2 policy file after parsing. Duplicate keys are an error.
 * The JSON value matches `schema/policy.schema.json`. Unknown fields are errors.
 * `imports` and `items` default to empty arrays when omitted.
 */
export type PolicyDocument = {
  specVersion: SpecVersion;
  /**
   * Human prose, including prerequisites of a shared collection. It changes
   * evaluation only by changing the file hash inside the policy identity.
   * 1 to 500 characters when present.
   */
  description?: string;
  retry?: RetryPolicy;
  /** At most 64 imports. */
  imports?: PolicyImport[];
  /** At most 128 items. */
  items?: PolicyItem[];
  setup?: PolicySetupStep[];
};

/** One file that contributes to the policy digest. `sha256` is 64 lowercase hex characters. */
export type PolicyFile = {
  /**
   * Repository-root-relative path of a policy file or a regular file under a
   * referenced skill directory. For a global policy these paths are relative
   * to the home directory. Sorted by UTF-16 code unit in the identity document.
   */
  path: string;
  sha256: string;
};

/**
 * Where the entry file was read.
 *
 * - `repo`: `.agents/closeout.yaml` on `refs/heads/main` of the remote `origin`.
 *   The work tree and the local `main` ref are not policy sources.
 * - `global`: that commit has no entry file, so `~/.agents/closeout.yaml` was
 *   read. Imports and skills resolve from the home directory. Commands still
 *   run in the candidate repository. The decision warning code is `global-policy`.
 * - `none`: the remote entry and the global file are both absent. There are
 *   no requirements. `validate` succeeds. A decision is `accepted` with message
 *   `no closeout policy`.
 *
 * A file that exists and fails to load is not `none`. Acceptance is `blocked`.
 */
export type PolicySource = "repo" | "global" | "local" | "none";

/**
 * Resolved command, in canonical form. `paths` is omitted when the item has none.
 * `specVersion` section 6.
 */
export type ResolvedCommand = {
  id: string;
  kind: "command";
  gate: Gate;
  exec: string[];
  timeoutSeconds: number;
  paths?: string[];
};

/** Resolved review, in canonical form. `independence` has both flags. */
export type ResolvedReview = {
  id: string;
  kind: "review";
  gate: Gate;
  skill: string;
  independence: Independence;
  failOn: Severity;
  paths?: string[];
};

/**
 * Resolved setup step. The file has no `kind` and no `gate`; resolution sets
 * `kind` to `setup` and `gate` to `beforePR`. Setup steps are not items.
 */
export type ResolvedSetup = {
  id: string;
  kind: "setup";
  gate: Gate;
  exec: string[];
  timeoutSeconds: number;
  paths?: string[];
};

/**
 * Canonical form of a kind other than `command`, `review`, or `setup`:
 * `{ id, kind, gate, supported: false }`, plus `paths` when present.
 *
 * `policy.schema.json` rejects an unknown kind, and the `unknown-kind`
 * conformance fixture fails `validate`. A loader that follows the schema
 * blocks before resolution. The variant remains so an evaluator can represent
 * a kind it does not run. When the item applies, its state is `unsupported`
 * and the decision is `blocked`. A `paths` miss is still `skipped`.
 *
 * Narrow this variant with `"supported" in item` before switching on `kind`.
 * `kind` is the declared kind string, not the word `unsupported`.
 */
export type ResolvedUnsupported = {
  id: string;
  kind: string;
  gate: Gate;
  supported: false;
  paths?: string[];
};

/** Every resolved requirement, including setup steps. */
export type ResolvedItem = ResolvedCommand | ResolvedReview | ResolvedSetup | ResolvedUnsupported;

/** Members of `ResolvedPolicy.items`. Setup steps live on `setup`. */
export type ResolvedRequirement = Exclude<ResolvedItem, ResolvedSetup>;

/**
 * Effective policy after imports, in execution order.
 *
 * `digest` is `sha256:` plus 64 lowercase hex characters: the SHA-256 of the
 * UTF-8 canonical JSON of {@link PolicyIdentity}. Evidence bound to another
 * digest does not satisfy this one.
 *
 * Canonical JSON for this edition: object keys sorted by UTF-16 code unit,
 * arrays in the order given, JSON string encoding, safe integers in base 10
 * with no exponent, and no insignificant whitespace. `setup` is omitted when
 * there are no setup steps. `retry` is omitted when the entry has no limit.
 * An item omits `paths` when it has none.
 */
export type ResolvedPolicyPresent = {
  skillFiles?: ReadonlyMap<string, Uint8Array>;
  source: "repo" | "global" | "local";
  digest: string;
  /**
   * Entry that was read, stored on the decision as `policy.path`.
   * `repo` is `.agents/closeout.yaml`. `global` is `~/.agents/closeout.yaml`.
   */
  entryPath: string;
  /** In file order. Empty when the entry omits `setup`. */
  setup: ResolvedSetup[];
  /** In execution order, after depth-first import. */
  items: ResolvedRequirement[];
  retry?: RetryPolicy;
  /** Each policy file that was read, and every regular file under each referenced skill, once. */
  files: PolicyFile[];
};

/** Both the remote entry and the global file are absent. Arrays are empty. */
export type ResolvedPolicyAbsent = {
  source: "none";
  digest: null;
  entryPath: null;
  setup: ResolvedSetup[];
  items: ResolvedRequirement[];
  files: PolicyFile[];
};

export type ResolvedPolicy = ResolvedPolicyPresent | ResolvedPolicyAbsent;

/**
 * The document that is hashed to produce `ResolvedPolicy.digest`.
 * `files` is sorted by `path`. `items` stays in execution order.
 * `setup` is in the order written and is omitted when empty.
 */
export type PolicyIdentity = {
  specVersion: SpecVersion;
  files: PolicyFile[];
  items: ResolvedRequirement[];
  setup?: ResolvedSetup[];
  retry?: RetryPolicy;
};

/**
 * Result of reading the entry policy.
 * `ok: false` is a failed load, which is blocked acceptance with
 * `policy.absent` false, `policy.path` null, and `policy.digest` null.
 * It is not an empty requirement list.
 */
export type PolicyLoadResult =
  | { ok: true; policy: ResolvedPolicy }
  | {
      ok: false;
      /**
       * `repo` when `origin` `refs/heads/main` cannot be read or its entry fails.
       * The global file is not a substitute for an unreadable remote.
       * `global` when the home file exists and fails.
       */
      source: "repo" | "global" | "local";
      message: string;
    };

export type Finding = {
  severity: Severity;
  /** Where the reviewer looked. 1 to 512 characters. */
  location: string;
  /** What is wrong, or what the reviewer checked. 1 to 8000 characters. */
  explanation: string;
  /** The observation that supports the finding. 1 to 8000 characters. */
  evidence: string;
};

/** Portable path plus SHA-256 of the file bytes. At most 16 references on a record. */
export type Artifact = {
  path: string;
  sha256: string;
};

export type ProducerIdentity = {
  name: string;
  version: string;
};

/** Reviewer identity. Compared with {@link CandidateIdentity} for independence. */
export type ReviewProducer = {
  session: string;
  model: string;
  provider: string;
};

/**
 * Execution facts for one argv invocation. `exitCode` null and `timedOut` false
 * means the process could not start. `dirty` means the worktree status after
 * the process is non-empty and differs from the status before it. Setup steps
 * may leave files; a later command does not fail for dirt an earlier setup left.
 */
export type CommandExec = {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  dirty: boolean;
  headMoved: boolean;
  /** Integer milliseconds, zero or greater. */
  durationMs: number;
  truncated: boolean;
};

/**
 * Command evidence. Matches `schema/evidence.schema.json`.
 * A record applies only when `itemId`, `base`, `head`, and `policyDigest` equal
 * the evaluation inputs. Under task retry scope, `task` must also match.
 * `attempt` is an integer from 1 to 100000. The greatest matching attempt is used.
 * Two records with the same identity and the same attempt are an error for that item.
 *
 * Accepted only from a producer the evaluator is configured to trust, and only
 * when `exec.argv` equals the policy argv. The reference runner trusts the
 * producer name `closeout-reference` at its own version. A content hash binds
 * the record to its bytes and does not prove who wrote it. Setup steps use this
 * same record shape.
 */
export type CommandRecord = {
  specVersion: SpecVersion;
  recordType: "command";
  /** Present when the record was produced with a task id. 1 to 256 characters. */
  task?: string;
  itemId: string;
  /** Lowercase hex git commit id, 40 or 64 characters, resolved before execution. */
  base: string;
  head: string;
  policyDigest: string;
  attempt: number;
  evaluator: ProducerIdentity;
  producer: ProducerIdentity;
  exec: CommandExec;
  artifacts: Artifact[];
};

/**
 * Review evidence. The record carries findings, not an outcome.
 * The evaluator computes pass or fail from the findings, `failOn`, and independence.
 * Any schema-invalid file in the evidence directory blocks the decision.
 */
export type ReviewRecord = {
  specVersion: SpecVersion;
  recordType: "review";
  task?: string;
  itemId: string;
  base: string;
  head: string;
  policyDigest: string;
  attempt: number;
  evaluator: ProducerIdentity;
  producer: ReviewProducer;
  /** At most 200 findings. */
  findings: Finding[];
  artifacts: Artifact[];
};

export type EvidenceRecord = CommandRecord | ReviewRecord;

/**
 * Candidate identity supplied by the orchestrator. Omitting a session, model,
 * or provider leaves it empty, which does not satisfy a `true` independence flag.
 * `task` is the stable id for `run`, `decision`, and evidence intake.
 */
export type CandidateIdentity = {
  task?: string;
  session: string;
  model: string;
  provider: string;
};

/**
 * Evaluated state of one setup step or item at the requested gate.
 * Spec section 8. The decision is `blocked` when any requirement is in the
 * blocked class, or when policy loading failed, or when the evidence directory
 * is unreadable, or when a setup step or item has `paths` and the changed-path
 * diff cannot be read. Otherwise it is `rejected` when any requirement failed.
 * Otherwise it is `accepted`.
 *
 * Not required: `skipped`.
 * Satisfied: `passed`.
 * Rejected: `failed`.
 * Blocked: `exhausted`, `unsupported`, `missing`, `stale`, `invalid`,
 * `untrusted`, `independence`.
 *
 * A path miss uses message `no changed path matches`. A later setup step or
 * command with no evidence because an earlier setup step failed uses message
 * `setup failed`; that skip does not block. When the diff cannot be read, the
 * decision message starts with `changed paths are unavailable` and those
 * requirements are not marked `skipped`.
 */
export type ItemState =
  | "skipped"
  | "exhausted"
  | "unsupported"
  | "missing"
  | "stale"
  | "invalid"
  | "untrusted"
  | "failed"
  | "passed"
  | "independence";

/**
 * `accepted` exits 0, `rejected` exits 1, `blocked` exits 3.
 * Exit 2 is an invalid invocation and is not a decision document.
 */
export type DecisionName = "accepted" | "rejected" | "blocked";

export type DecisionItem = {
  id: string;
  /** `command`, `review`, `setup`, or the declared kind of an unsupported item. */
  kind: string;
  state: ItemState;
  message: string;
  /** Positive integer. Present when a matching record was judged. */
  attempt?: number;
};

export type DecisionWarning = {
  code: string;
  message: string;
};

/**
 * Policy identity copied onto the decision.
 * Absent policy: `path` null, `digest` null, `absent` true.
 * Failed load: `path` null, `digest` null, `absent` false.
 */
export type DecisionPolicy = {
  path: string | null;
  digest: string | null;
  absent: boolean;
};

/** Matches `schema/decision.schema.json`. Only `accepted` may be published or merged. */
export type DecisionDocument = {
  specVersion: SpecVersion;
  decision: DecisionName;
  gate: Gate;
  base: string;
  head: string;
  /** At most 4000 characters. `no closeout policy` when the entry is absent. */
  message?: string;
  candidate: CandidateIdentity;
  policy: DecisionPolicy;
  items: DecisionItem[];
  warnings: DecisionWarning[];
};

export type EvidenceInvalid = {
  /** Set when one file is the problem. */
  path?: string;
  message: string;
};

/**
 * Every record in the evidence directory, plus a block when the directory
 * cannot be read or any file fails the evidence schema. Callers block the
 * decision when `invalid` is set. They do not drop that file and continue.
 */
export type EvidenceSnapshot = {
  records: EvidenceRecord[];
  invalid?: EvidenceInvalid;
};

/**
 * Persistence for command and review records. Matching and the greatest-attempt
 * rule belong to the evaluator. The reference layout is `.closeout/evidence/`
 * for records and `.closeout/logs/` for command logs, outside the committed policy.
 */
export interface EvidenceStore {
  load(): Promise<EvidenceSnapshot>;
  /**
   * Write the next attempt. Does not decide acceptance.
   * A second record with the same `itemId`, `base`, `head`, `policyDigest`,
   * and `attempt` is an error.
   */
  add(record: EvidenceRecord): Promise<void>;
}

export type CommandRunRequest = {
  /** Detached worktree checked out at the candidate commit. */
  cwd: string;
  /** Argv executed directly. This port does not invoke a shell. */
  argv: string[];
  /** Policy limit, from 1 to 86400 seconds. */
  timeoutSeconds: number;
};

export type CommandRunResult = CommandExec & {
  artifacts: Artifact[];
};

/**
 * Runs one setup step or command in the candidate worktree.
 * The caller writes the {@link CommandRecord} and applies the dirt rule:
 * setup may leave files; a command fails when it leaves new dirt.
 */
export interface CommandRunner {
  run(request: CommandRunRequest): Promise<CommandRunResult>;
}

export type ReviewRequest = {
  skillFiles?: ReadonlyMap<string, Uint8Array>;
  item: ResolvedReview;
  candidate: CandidateIdentity;
  base: string;
  head: string;
  policyDigest: string;
  /** Candidate checkout the reviewer reads. */
  worktree: string;
};

/** Findings and reviewer identity. The outcome is computed later. */
export type ReviewResult = {
  producer: ReviewProducer;
  findings: Finding[];
  artifacts: Artifact[];
};

/**
 * Produces a review record's findings. A review requirement is not executed
 * by {@link CommandRunner}. A missing review stays `missing`.
 */
export interface Reviewer {
  review(request: ReviewRequest): Promise<ReviewResult>;
}
