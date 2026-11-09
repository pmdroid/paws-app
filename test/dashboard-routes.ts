import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type Surface = "spa" | "settings" | "html" | "legacy" | "http";

export type Disposition = "canonical" | "alias" | "preserved" | "delegated" | "removed";

export interface RouteEntry {
  surface: Surface;
  method: string;
  pattern: string;
  disposition: Disposition;
  owner: string;
  view?: string;
  via?: string | null;
  sample?: string;
  anonymous?: number;
  member?: number;
}

const spa = (
  pattern: string,
  view: string,
  disposition: Disposition,
  owner: string,
): RouteEntry => ({ surface: "spa", method: "GET", pattern, view, disposition, owner });

const api = (
  method: string,
  pattern: string,
  disposition: Disposition,
  owner: string,
  extra: Partial<RouteEntry> = {},
): RouteEntry => ({ surface: "http", method, pattern, disposition, owner, ...extra });

export const SETTINGS_PAGE_IDS = [
  "decisions",
  "agents",
  "merging",
  "limits",
  "brief",
  "findings",
  "integrations",
  "members",
  "workspace",
  "account",
  "audit",
];

export const DASHBOARD_ROUTES: RouteEntry[] = [
  spa("/", "overview", "canonical", "PAS-903"),
  spa("/overview", "overview", "alias", "PAS-895"),
  spa("/queue", "overview", "alias", "PAS-895"),
  spa("/issues", "issues", "canonical", "PAS-901"),
  spa("/issues/:id", "issues", "canonical", "PAS-901"),
  spa("/epics", "issues", "alias", "PAS-895"),
  spa("/epics/:id", "issues", "alias", "PAS-895"),
  spa("/runs", "issues", "alias", "PAS-902"),
  spa("/runs/:id", "alias", "alias", "PAS-902"),
  spa("/sessions", "issues", "alias", "PAS-902"),
  spa("/sessions/:id", "alias", "alias", "PAS-902"),
  spa("/verdicts", "issues", "alias", "PAS-902"),
  spa("/verdicts/:id", "alias", "alias", "PAS-902"),
  spa("/questions", "questions", "canonical", "PAS-904"),
  spa("/questions/:id", "questions", "canonical", "PAS-904"),
  spa("/merge-queue", "mergeQueue", "canonical", "PAS-905"),
  spa("/evidence", "evidence", "canonical", "PAS-906"),
  spa("/evidence/:id", "evidence", "canonical", "PAS-906"),
  spa("/runners", "runners", "preserved", "src/runner-control"),
  spa("/runners/:id", "runners", "preserved", "src/runner-control"),
  spa("/findings", "findings", "preserved", "src/dashboard"),
  spa("/improvements", "improvements", "canonical", "PAS-918"),
  spa("/improvements/:id", "improvements", "canonical", "PAS-918"),
  spa("/improvements/reports/:id", "improvements", "canonical", "PAS-918"),
  spa("/improvements/history", "improvements", "canonical", "PAS-918"),
  spa("/improvements/settings", "improvements", "canonical", "PAS-918"),
  spa("/retros", "improvements", "alias", "PAS-918"),
  spa("/retros/:id", "improvements", "alias", "PAS-918"),
  spa("/settings", "settings", "preserved", "src/settings"),
  ...SETTINGS_PAGE_IDS.map((id): RouteEntry => ({
    surface: "settings",
    method: "GET",
    pattern: `/settings/${id}`,
    view: "settings",
    disposition: "preserved",
    owner: "src/settings",
  })),
  {
    surface: "html",
    method: "GET",
    pattern: "index.html",
    disposition: "canonical",
    owner: "PAS-895",
  },
  {
    surface: "html",
    method: "GET",
    pattern: "transcript.html",
    disposition: "canonical",
    owner: "PAS-895",
  },
  {
    surface: "legacy",
    method: "GET",
    pattern: "#/:path",
    disposition: "alias",
    owner: "PAS-895",
  },

  api("GET", "/dashboard", "canonical", "PAS-895", { sample: "/dashboard/", member: 200 }),
  api("GET", "/dashboard/:page", "canonical", "PAS-895", {
    via: "/dashboard",
    sample: "/dashboard/issues/PAS-1",
    member: 200,
  }),
  api("GET", "/dashboard/runs/:id/transcript", "canonical", "PAS-895", {
    via: "/dashboard",
    sample: "/dashboard/runs/{run}/transcript",
    member: 200,
  }),
  api("GET", "/dashboard/assets/:file", "canonical", "PAS-895", { via: "/dashboard" }),
  api("GET", "/", "alias", "PAS-895", { via: null, sample: "/?from=linear", anonymous: 307 }),
  api("GET", "/status", "alias", "PAS-895", { sample: "/status", anonymous: 307 }),
  api("GET", "/status/:page", "alias", "PAS-895", {
    via: "/status",
    sample: "/status/issues/PAS-1?from=linear",
    anonymous: 307,
  }),
  api("POST", "/status/:page", "alias", "PAS-895", {
    via: "/status",
    sample: "/status/issues/PAS-1",
    anonymous: 405,
  }),
  api("GET", "/evidence/:id", "alias", "PAS-906", {
    sample: "/evidence/01JEV1DENCE0000000000000AB",
    anonymous: 307,
  }),

  api("GET", "/api/overview", "canonical", "PAS-903", { sample: "/api/overview", member: 200 }),
  api("GET", "/api/issues", "canonical", "PAS-859", { sample: "/api/issues", member: 200 }),
  api("GET", "/api/issues/:id", "canonical", "PAS-859", {
    via: "/api/issues",
    sample: "/api/issues/PAS-1",
    member: 200,
  }),
  api("GET", "/api/issues/:id/attempts/:attempt/checks/:check/log", "canonical", "PAS-859", {
    via: "/api/issues",
    sample: "/api/issues/PAS-1/attempts/1/checks/test/log",
    member: 404,
  }),
  api("GET", "/api/questions", "canonical", "PAS-904", { sample: "/api/questions", member: 200 }),
  api("GET", "/api/questions/:id", "canonical", "PAS-904", {
    via: "/api/questions",
    sample: "/api/questions/q-PAS-1",
    member: 200,
  }),
  api("GET", "/api/merge-queue", "canonical", "PAS-905", {
    sample: "/api/merge-queue",
    member: 200,
  }),
  api("GET", "/api/evidence", "canonical", "PAS-906", { sample: "/api/evidence", member: 200 }),
  api("GET", "/api/evidence/:id/metadata", "canonical", "PAS-906", {
    via: "/api/evidence",
    sample: "/api/evidence/{evidence}/metadata",
    member: 200,
  }),
  api("GET", "/api/evidence/:id", "preserved", "src/evidence", {
    sample: "/api/evidence/{evidence}",
    member: 200,
  }),
  api("GET HEAD", "/api/evidence/*", "preserved", "src/evidence"),
  api("GET", "/api/aliases/:kind/:id", "canonical", "PAS-902", {
    via: "/api/aliases",
    sample: "/api/aliases/runs/{run}",
    member: 200,
  }),
  api("GET", "/api/status", "removed", "PAS-907", {
    via: null,
    sample: "/api/status",
    member: 404,
  }),
  api("GET", "/api/status/items/:id", "removed", "PAS-907", {
    via: null,
    sample: "/api/status/items/PAS-1",
    member: 404,
  }),
  api("GET", "/api/closeout-artifact", "preserved", "src/dashboard", {
    sample: "/api/closeout-artifact",
  }),
  api("GET", "/api/runs/transcript", "preserved", "src/dashboard", {
    sample: "/api/runs/transcript?run={run}",
  }),
  api("GET", "/api/linear/artifacts/*", "preserved", "src/dashboard"),
  api("GET POST", "/api/linear/sessions", "preserved", "src/dashboard", {
    sample: "/api/linear/sessions",
  }),
  api("POST", "/api/link-asks", "preserved", "src/questions", { sample: "/api/link-asks" }),
  api("POST", "/api/questions/answer", "preserved", "src/questions", {
    sample: "/api/questions/answer",
  }),
  api("GET POST", "/api/execution-controls", "preserved", "src/execution-controls", {
    sample: "/api/execution-controls",
  }),
  api("POST", "/api/blocker-checks", "preserved", "src/intake", {
    sample: "/api/blocker-checks",
  }),
  api("GET POST", "/api/findings", "preserved", "src/dashboard", { sample: "/api/findings" }),
  api("GET POST", "/api/finding-groups", "preserved", "src/dashboard", {
    sample: "/api/finding-groups",
  }),
  api("POST", "/api/review-findings/issues", "preserved", "src/finding-issues", {
    sample: "/api/review-findings/issues",
  }),
  api("POST", "/api/visual-review-changes", "preserved", "src/evidence", {
    sample: "/api/visual-review-changes",
  }),
  api("*", "/api/*", "preserved", "src/server", { sample: "/api/unknown" }),
  api("*", "/api/settings/*", "preserved", "src/settings"),
  ...[
    "agents",
    "brief",
    "brief/preview",
    "checkout",
    "findings",
    "hooks",
    "merging",
    "skills",
    "time-limits",
  ].map((page) =>
    api(
      page === "brief/preview" ? "POST" : "GET PUT",
      `/api/settings/${page}`,
      "preserved",
      "src/settings",
      {
        sample: `/api/settings/${page}`,
      },
    ),
  ),
  api("*", "/api/retros/*", "delegated", "src/retros"),
  api("GET PUT", "/api/retros/settings", "delegated", "src/retros", {
    sample: "/api/retros/settings",
  }),
  api("GET PUT", "/api/retros/schedule", "delegated", "src/retros", {
    sample: "/api/retros/schedule",
  }),
  api("POST", "/api/retros/runs", "delegated", "src/retros", { sample: "/api/retros/runs" }),
  api("POST", "/api/retros/preview", "delegated", "src/retros", {
    sample: "/api/retros/preview",
  }),
  api("GET", "/api/retros/history", "delegated", "src/retros", { sample: "/api/retros/history" }),
  api("GET", "/api/retros/reports/:id", "delegated", "src/retros", {
    sample: "/api/retros/reports/{run}",
  }),
  ...["digest", "report", "prompt", "settings", "items/:item/evidence"].map((file) =>
    api("GET", `/api/retros/reports/:id/${file}`, "delegated", "src/retros", {
      via: "/api/retros/reports/:id",
    }),
  ),
  api("GET", "/api/improvements", "delegated", "src/improvements", {
    sample: "/api/improvements",
  }),
  api("*", "/api/improvements/*", "delegated", "src/improvements", {
    via: "/api/improvements/",
  }),
  api("GET", "/api/improvements/:id", "delegated", "src/improvements", {
    sample: "/api/improvements/{run}",
  }),
  api("POST", "/api/improvements/:id/decision", "delegated", "src/improvements", {
    sample: "/api/improvements/{run}/decision",
  }),
  api("GET", "/api/improvements/attention", "delegated", "src/improvements", {
    sample: "/api/improvements/attention",
  }),
  api("GET", "/api/improvements/:id/follow-through", "delegated", "src/improvements", {
    sample: "/api/improvements/{run}/follow-through",
  }),
  ...["delegate", "verification", "criterion", "recovery"].map((action) =>
    api("POST", `/api/improvements/:id/${action}`, "delegated", "src/improvements"),
  ),
  api("POST", "/api/improvements/:id/deliveries/:delivery/retry", "delegated", "src/improvements"),
  api("POST", "/api/improvements/:id/deliveries/:delivery/cancel", "delegated", "src/improvements"),
  api(
    "POST",
    "/api/improvements/:id/deliveries/:delivery/destination",
    "delegated",
    "src/improvements",
  ),
  api("GET", "/api/runners", "delegated", "src/runner-control", { sample: "/api/runners" }),
  ...[
    ["POST", "/api/runners/enrollments"],
    ["GET", "/api/runners/usage"],
    ["GET", "/api/runners/models"],
    ["GET POST", "/api/runners/accounts"],
    ["POST", "/api/runners/coding-agents/update-all"],
    ["POST", "/api/runners/:id/coding-agents/:agent/update"],
    ["POST", "/api/runners/:id/status"],
    ["GET", "/api/runners/:id/health"],
    ["PUT", "/api/runners/:id/concurrency"],
    ["PUT", "/api/runners/:id/repositories"],
    ["GET PUT", "/api/runners/:id/policy"],
    ["POST", "/api/runners/:id/agents/:agent/extra-usage"],
    ["GET POST", "/api/runners/:id/accounts"],
    ["POST", "/api/runners/:id/sessions/move"],
    ["POST", "/api/runners/:id/sessions/:session/move"],
    ["GET POST", "/api/runners/vm"],
    ["POST", "/api/runners/vm/delete"],
    ["POST", "/api/runners/vm/retry"],
    ["POST", "/api/runners/vm/pool"],
    ["GET", "/api/runners/vm/pools"],
  ].map(([method, pattern]) =>
    api(method!, pattern!, "delegated", "src/runner-control", {
      sample: pattern!.replaceAll(":id", "01JRUNNER0000000000000000A"),
    }),
  ),
  ...[
    ["POST", "/api/runners/accounts/preview"],
    ["PUT DELETE", "/api/runners/accounts/:id"],
  ].map(([method, pattern]) =>
    api(method!, pattern!, "delegated", "src/runner-control", {
      via: "/api/runners/accounts",
      sample: pattern!.replaceAll(":id", "01JRUNNER0000000000000000A"),
    }),
  ),
  api("POST", "/api/runner-enrollments", "delegated", "src/runner-control"),
  ...[
    ["GET", "/api/auth/session", 401],
    ["POST", "/api/auth/logout", undefined],
    ["GET", "/api/workspaces", 401],
    ["POST", "/api/workspaces/select", undefined],
    ["GET POST", "/api/workspaces/members", 401],
    ["GET PUT", "/api/workspaces/repositories", 401],
    ["GET", "/api/workspaces/audit", 401],
    ["GET POST", "/api/workspaces/decisions", 401],
    ["GET POST", "/api/workspaces/identity-links", 401],
    ["GET POST", "/api/workspaces/github-attribution", 401],
    ["GET POST", "/api/workspaces/github-integration", 401],
    ["GET POST", "/api/workspaces/github-connect", null],
    ["GET POST", "/api/workspaces/github-setup", null],
  ].map(([method, pattern, anonymous]) =>
    api(method as string, pattern as string, "delegated", "src/workspace", {
      ...(anonymous === null ? {} : { sample: pattern as string }),
      ...(typeof anonymous === "number" ? { anonymous } : {}),
    }),
  ),
  api("GET", "/auth/linear", "delegated", "src/workspace"),
  api("GET", "/auth/linear/callback", "delegated", "src/workspace"),
  api("GET", "/auth/linear/install/callback", "delegated", "src/onboarding"),
  api("GET", "/auth/github-app/callback", "delegated", "src/server"),
  api("GET", "/auth/github-attribution/callback", "delegated", "src/workspace"),
  api("GET", "/oauth/slack/callback", "delegated", "src/slack"),
  api("GET POST", "/onboard/:id", "delegated", "src/onboarding"),
  api("GET POST", "/onboard/:id/github", "delegated", "src/onboarding", { via: "/onboard/:id" }),
  api("GET", "/onboard/*", "delegated", "src/onboarding"),
  api("GET", "/health", "preserved", "src/server", { sample: "/health", anonymous: 200 }),
  api("POST", "/webhooks", "preserved", "src/server"),
  api("POST", "/webhooks/*", "preserved", "src/server"),
  api("POST", "/webhooks/linear", "preserved", "src/linear"),
  api("POST", "/webhooks/github", "preserved", "src/github"),
  api("POST", "/webhooks/slack", "preserved", "src/slack"),
];

const ROUTE_ROOTS = "api|webhooks|auth|onboard|oauth|health|dashboard|status|evidence";
const QUOTED = new RegExp(`(["'\`])\\^?(/(?:${ROUTE_ROOTS})(?:[/?#<$][^"'\`\\n]*?)?)\\1`, "g");
const REGEX = new RegExp(`/\\^(\\\\/(?:${ROUTE_ROOTS})(?:[^/\\n\\\\]|\\\\.)*)/[gimsuy]*`, "g");

export interface SourceRoute {
  path: string;
  file: string;
}

function productionFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          !["testing", "test", "migrations"].includes(entry.name) &&
          path !== join(root, "src/db/schema") &&
          path !== join(root, "src/db/schema-pg")
        )
          walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|^migrations?\b/.test(entry.name))
        files.push(path);
    }
  };
  walk(join(root, "src"));
  return files;
}

function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

export function normalizeRoute(literal: string): string {
  let path = literal
    .replace(/\\\//g, "/")
    .replace(/\(\?:[^)]*\)\?/g, "")
    .replace(/\/\?\$?$/, "")
    .replace(/\$$/, "");
  let out = "";
  for (let index = 0; index < path.length; index++) {
    const start = path.startsWith("${", index) ? index + 1 : path[index] === "(" ? index : -1;
    if (start < 0) {
      out += path[index];
      continue;
    }
    let depth = 0;
    let end = start;
    for (; end < path.length; end++) {
      if (path[end] === "{" || path[end] === "(") depth++;
      if (path[end] === "}" || path[end] === ")") depth--;
      if (depth === 0) break;
    }
    if (!out.endsWith("/")) break;
    out += ":param";
    index = end;
  }
  return out
    .replace(/\[[^\]]*\](\{\d+(,\d*)?\}|\+|\*)?/g, ":param")
    .replace(/<[^>]+>/g, ":param")
    .split(/[?#]/)[0]!;
}

export function sourceRoutes(root: string): SourceRoute[] {
  const found = new Map<string, SourceRoute>();
  for (const file of productionFiles(root)) {
    const text = code(readFileSync(file, "utf8"));
    for (const pattern of [QUOTED, REGEX]) {
      for (const match of text.matchAll(pattern)) {
        const path = normalizeRoute(match[pattern === QUOTED ? 2 : 1]!);
        const key = `${path} ${relative(root, file)}`;
        if (!found.has(key)) found.set(key, { path, file: relative(root, file) });
      }
    }
  }
  return [...found.values()];
}

export function routeMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/*")) return path === pattern.slice(0, -1);
  if (path.endsWith("/*")) return pattern === path;
  const shape = new RegExp(
    `^${pattern
      .split("/")
      .map((part) => (part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}$`,
  );
  return shape.test(path);
}

export function routeHeads(root: string): string[] {
  const source = readFileSync(join(root, "src/dashboard/src/client/route.ts"), "utf8");
  const body = source.slice(source.indexOf("export function matchRoute"));
  const heads = [
    ...body.slice(0, body.indexOf("\n}\n")).matchAll(/case (?:"([^"]+)"|undefined):/g),
  ];
  return heads.map((match) => match[1] ?? "");
}

export function htmlEntrypoints(root: string): string[] {
  return readdirSync(join(root, "src/dashboard/src/client"))
    .filter((name) => name.endsWith(".html"))
    .sort();
}
