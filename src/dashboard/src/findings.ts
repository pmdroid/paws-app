/** `GET /api/findings` and `POST /api/findings`: the Findings page. */
export const FINDINGS_API_PATH = "/api/findings";

export const FINDING_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export const FINDING_STATUSES = ["open", "filed", "dismissed", "gone"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** The page's filters. `status` `all` lists every status; empty means any. */
export type FindingFilter = {
  repository: string;
  severity: FindingSeverity | "";
  review: string;
  status: FindingStatus | "all";
  path: string;
};

export const DEFAULT_FINDING_FILTER: FindingFilter = {
  repository: "",
  severity: "",
  review: "",
  status: "open",
  path: "",
};

/** One distinct finding. Text is model output; the page escapes it. */
export type FindingView = {
  id: number;
  repository: string;
  path: string;
  /** `12` or `12-20`; empty when the finding names no line. */
  lines: string;
  severity: FindingSeverity;
  review: string;
  text: string;
  bugClass: string;
  why: "pre-existing" | "below failOn";
  firstSeenAt: string;
  lastSeenAt: string;
  /** How many items reported it, including ones the reader cannot open. */
  itemCount: number;
  /** The items the reader can open, latest first. */
  items: { id: string; title: string }[];
  status: FindingStatus;
  /** Who set the status; null when Paws did. */
  statusBy: string | null;
  statusAt: string | null;
  statusReason: string | null;
  filedIssue: string | null;
};

export type FindingsResponse = {
  findings: FindingView[];
  /** How many findings match, before the list is cut to `FINDINGS_LIMIT`. */
  total: number;
  /** Per severity, the findings that match every filter except severity. */
  counts: Record<FindingSeverity, number>;
  /** The choices for the repository and review filters. */
  repositories: string[];
  reviews: string[];
};

/** The page lists at most this many findings. */
export const FINDINGS_LIMIT = 500;
/** A dismiss reason is at most this long. */
export const DISMISS_REASON_LIMIT = 500;

export type FindingAction =
  | { id: number; action: "dismiss"; reason: string }
  | { id: number; action: "reopen" };

/** The query string for `filter`, without the defaults. */
export function findingQuery(filter: FindingFilter): string {
  const params = new URLSearchParams();
  if (filter.repository) params.set("repository", filter.repository);
  if (filter.severity) params.set("severity", filter.severity);
  if (filter.review) params.set("review", filter.review);
  if (filter.status !== DEFAULT_FINDING_FILTER.status) params.set("status", filter.status);
  if (filter.path) params.set("path", filter.path);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The filter a query string asks for; unknown values fall back to the defaults. */
export function parseFindingQuery(search: string | URLSearchParams): FindingFilter {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const severity = params.get("severity") ?? "";
  const status = params.get("status") ?? DEFAULT_FINDING_FILTER.status;
  return {
    repository: params.get("repository")?.trim() ?? "",
    severity: (FINDING_SEVERITIES as readonly string[]).includes(severity)
      ? (severity as FindingSeverity)
      : "",
    review: params.get("review")?.trim() ?? "",
    status:
      status === "all" || (FINDING_STATUSES as readonly string[]).includes(status)
        ? (status as FindingFilter["status"])
        : DEFAULT_FINDING_FILTER.status,
    path: params.get("path")?.trim() ?? "",
  };
}
