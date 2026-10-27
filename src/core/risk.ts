/**
 * A candidate's risk tier comes from the paths it changes, never from its author. It is `high`
 * when a changed path matches a high-risk glob from the repository's Paws settings or from the
 * repository's `.paws/high-risk-paths` file at the candidate's base commit.
 */
export type RiskTier = "high" | "normal";
export type RiskClassification = {
  tier: RiskTier;
  /** The changed paths a high-risk glob matched, sorted. Empty when the tier is `normal`. */
  paths: string[];
};

/** The repository file read from the candidate's base commit. One glob per line, `#` comments. */
export const HIGH_RISK_PATHS_FILE = ".paws/high-risk-paths";
export const HIGH_RISK_PATHS_FILE_MAX_BYTES = 65_536;
export const HIGH_RISK_GLOB_MAX = 300;
export const HIGH_RISK_GLOBS_MAX = 200;

/**
 * Why `glob` is not a high-risk glob, or null when it is one. A glob matches the whole
 * repository-relative path, so `src/auth/**` covers everything under `src/auth`. A negated glob
 * would match almost every path, so it is refused rather than read as an exclusion.
 */
export function highRiskGlobError(glob: string): string | null {
  if (glob.length === 0) return "is empty";
  if (glob.length > HIGH_RISK_GLOB_MAX) return `is longer than ${HIGH_RISK_GLOB_MAX} characters`;
  if (glob !== glob.trim()) return "has leading or trailing spaces";
  if ([...glob].some((char) => char.charCodeAt(0) < 32)) return "has a control character";
  if (glob.startsWith("!")) return "cannot be negated; the list only adds high-risk paths";
  if (glob.startsWith("/")) return "must be relative to the repository root";
  if (glob.includes("\\")) return "must use / between directories";
  if (glob.split("/").some((part) => part === "." || part === ".."))
    return "must stay in the repository";
  return null;
}

/**
 * The globs in a `.paws/high-risk-paths` file. Blank lines and lines starting with `#` are
 * skipped; a line that is not a valid glob is skipped too, since the file can only add paths.
 */
export function parseHighRiskPathsFile(text: string): string[] {
  const globs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const glob = line.trim();
    if (glob === "" || glob.startsWith("#")) continue;
    if (highRiskGlobError(glob) !== null) continue;
    if (!globs.includes(glob)) globs.push(glob);
  }
  return globs;
}

/** The tier for a candidate that changes `changed`, given every applicable high-risk glob. */
export function classifyRisk(
  changed: readonly string[],
  globs: readonly string[],
): RiskClassification {
  const matchers = globs
    .filter((glob) => highRiskGlobError(glob) === null)
    .map((glob) => new Bun.Glob(glob));
  const paths = [...new Set(changed)]
    .filter((path) => matchers.some((matcher) => matcher.match(path)))
    .sort();
  return { tier: paths.length > 0 ? "high" : "normal", paths };
}

const LISTED_PATHS = 20;

/**
 * `Risk: high — src/auth/session.ts` for the pull request body and the Linear session. Null is a
 * head Paws could not classify.
 */
export function riskLine(risk: RiskClassification | null): string {
  if (risk === null) return "Risk: unknown — Paws could not read the paths this change touches";
  if (risk.tier === "normal") return "Risk: normal — no high-risk path changed";
  const listed = risk.paths.slice(0, LISTED_PATHS).map(codeSpan).join(", ");
  const more = risk.paths.length - LISTED_PATHS;
  return `Risk: high — ${listed}${more > 0 ? ` and ${more} more` : ""}`;
}

/**
 * Why a person's approval of `approvedHead` carried over to a later head: "The approval of
 * 4b317d5 carried over: none of the files the fix changed since then is a high-risk path
 * (`test/x.test.ts`)."
 */
export function riskCarryOverReason(approvedHead: string, changed: readonly string[]): string {
  const files = changed.length
    ? ` (${riskLine({ tier: "high", paths: [...changed] }).replace(/^Risk: high — /, "")})`
    : "";
  return `The approval of ${approvedHead.slice(0, 7)} carried over: none of the files the fix changed since then is a high-risk path${files}.`;
}

function codeSpan(path: string): string {
  const longest = Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = path.startsWith("`") || path.endsWith("`") ? " " : "";
  return `${fence}${pad}${path}${pad}${fence}`;
}
