import { journalCaught } from "../journal";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import type { Database } from "bun:sqlite";
import {
  CHECK_LOG_TAIL_BYTES,
  EVIDENCE_RESOURCE_PATH,
  GENERATED_AT_HEADER,
  ISSUES_API_PATH,
  MERGE_QUEUE_API_PATH,
  OVERVIEW_API_PATH,
  issueCheckLogPath,
  parseEvidenceListResponse,
  parseEvidenceMetadataResponse,
  parseIssueCheckLogResponse,
  parseIssueDetailResponse,
  parseIssueListResponse,
  parseMergeQueueResponse,
  parseOverviewResponse,
  parseQuestionDetailResponse,
  parseQuestionListResponse,
  QUESTIONS_API_PATH,
  type EvidenceListResponse,
  type EvidenceMetadataResponse,
  type IssueCheckLogResponse,
  type IssueDetailResponse,
  type IssueListResponse,
  type MergeQueueResponse,
  type OverviewResponse,
  type QuestionDetailResponse,
  type QuestionListResponse,
} from "../contract";
import {
  createLiveStatusProvider,
  emptyEvidenceList,
  emptyIssueList,
  emptyMergeQueue,
  emptyQuestionList,
  type CheckLogRequest,
  type CheckOutput,
  type LiveStatusOptions,
} from "../live/provider";
import { emptyOverview } from "../live/overview";
import { ALIAS_API_PATH, isAliasKind, type AliasKind, type AliasResponse } from "../aliases";
import { ARTIFACT_API_PATH, readCloseoutArtifact } from "./artifact";
import { handleLinearArtifactRequest, type ReadLinearArtifact } from "./linear-artifact";
import { injectCsrf } from "./csrf";
import { dashboardResponseSizes, type ResponseSizeJournal } from "./response-size";
import { handleSessionStartRequest, type StartLinearSession } from "./session-start";
import { handleAgentTranscriptRequest } from "./transcript";
import {
  DASHBOARD_PATH,
  dashboardPath,
  isDashboardPath,
  legacyDashboardLocation,
} from "../../../dashboard-links";

export interface StatusProvider {
  /** One check's whole output. Null, or no reader, answers 404. */
  checkLog?(request: CheckLogRequest): CheckOutput | null | Promise<CheckOutput | null>;
  issues?(): IssueListResponse | Promise<IssueListResponse>;
  issue?(id: string): IssueDetailResponse | null | Promise<IssueDetailResponse | null>;
  overview?(): OverviewResponse | Promise<OverviewResponse>;
  mergeQueue?(): MergeQueueResponse | Promise<MergeQueueResponse>;
  questions?(): QuestionListResponse | Promise<QuestionListResponse>;
  question?(id: string): QuestionDetailResponse | null | Promise<QuestionDetailResponse | null>;
  alias?(kind: AliasKind, id: string): string | null | Promise<string | null>;
  evidence?(): EvidenceListResponse | Promise<EvidenceListResponse>;
  evidenceMetadata?(
    id: string,
  ): EvidenceMetadataResponse | null | Promise<EvidenceMetadataResponse | null>;
}

export interface StatusServerOptions {
  sessionIds?: readonly string[];
  trustedOrigin?: string;
  /**
   * Live reader for the dashboard resources.
   * Omit it and pass `db` to read the engine database. Omit both for empty
   * live resources (`source: "live"`, no items).
   */
  provider?: StatusProvider;
  /** Opened engine database. Ignored when `provider` is set. */
  db?: Database;
  /**
   * Directory from `bun run build:dashboard` (`index.html`, `assets/`).
   * Omit it to use `src/dashboard/dist` when that build exists. Pass `null` to skip files.
   */
  staticDir?: string | null;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  csrfToken?: string;
  closeoutHome?: string;
  evidenceRoot?: string;
  readLinearArtifact?: ReadLinearArtifact;
  startLinearSession?: StartLinearSession;
  linearUsage?: LiveStatusOptions["linearUsage"];
  riskApproval?: LiveStatusOptions["riskApproval"];
  /** Where resource response sizes go. Defaults to the process's per-minute journal line. */
  responseSizes?: ResponseSizeJournal;
  /**
   * Reuses each built resource body for a second; the engine passes `dashboardResources`.
   * Omit it to build the body on every request.
   */
  resourceCache?: ResourceCache;
}

export function fakeStatusProvider(): StatusProvider {
  return {
    checkLog() {
      return null;
    },
    issues() {
      return emptyIssueList();
    },
    issue() {
      return null;
    },
    overview() {
      return emptyOverview();
    },
    mergeQueue() {
      return emptyMergeQueue();
    },
    questions() {
      return emptyQuestionList();
    },
    question() {
      return null;
    },
    alias() {
      return null;
    },
    evidence() {
      return emptyEvidenceList();
    },
    evidenceMetadata() {
      return null;
    },
  };
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": `ETag, ${GENERATED_AT_HEADER}`,
  "Access-Control-Max-Age": "86400",
};

/**
 * Status routes only. Returns null for every other path so the engine can
 * keep routing webhooks itself.
 */
export async function handleStatusRequest(
  request: Request,
  options: StatusServerOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const legacy =
    pathname === "/"
      ? dashboardPath(`/${url.search}`)
      : legacyDashboardLocation(pathname, url.search);
  if (legacy !== null) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return text("Method not allowed", 405);
    return redirect(legacy);
  }
  const evidence = /^\/evidence\/([0-9A-HJKMNP-TV-Z]{26})\/?$/.exec(pathname);
  if (evidence) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return text("Method not allowed", 405);
    return redirect(dashboardPath(`/evidence/${evidence[1]}${url.search}`));
  }
  const transcript = handleAgentTranscriptRequest(request, options);
  if (transcript !== null) return transcript;
  const artifact = await handleLinearArtifactRequest(
    request,
    options.readLinearArtifact,
    options.trustedOrigin,
  );
  if (artifact !== null) return artifact;
  const session = await handleSessionStartRequest(request, options);
  if (session !== null) return session;
  const sizes = options.responseSizes ?? dashboardResponseSizes;
  if (pathname === OVERVIEW_API_PATH)
    return overviewResponse(request, options, sizes, options.resourceCache ?? UNCACHED);
  if (pathname === ISSUES_API_PATH || pathname.startsWith(`${ISSUES_API_PATH}/`))
    return issuesResponse(request, options, sizes, options.resourceCache ?? UNCACHED);
  if (pathname === QUESTIONS_API_PATH || pathname.startsWith(`${QUESTIONS_API_PATH}/`))
    return questionsResponse(request, options, sizes, options.resourceCache ?? UNCACHED);
  if (pathname.startsWith(`${ALIAS_API_PATH}/`))
    return aliasResponse(request, providerFor(options), pathname);
  if (pathname === MERGE_QUEUE_API_PATH)
    return mergeQueueResponse(request, options, sizes, options.resourceCache ?? UNCACHED);
  if (pathname === EVIDENCE_RESOURCE_PATH || pathname.startsWith(`${EVIDENCE_RESOURCE_PATH}/`))
    return evidenceResponse(request, options, sizes, options.resourceCache ?? UNCACHED);
  if (pathname === ARTIFACT_API_PATH) return artifactResponse(request, options);
  if (isDashboardPath(pathname)) {
    const staticDir = options.staticDir === undefined ? defaultStaticDir() : options.staticDir;
    return pageResponse(request, staticDir, options.csrfToken);
  }
  return null;
}

/** HTML for `GET /dashboard`, including the fallback when the static build is missing. */
export function statusResponse(): Response {
  return pageResponse(new Request(`http://127.0.0.1${DASHBOARD_PATH}`), defaultStaticDir());
}

export function startStatusServer(options?: {
  port?: number;
  hostname?: string;
  provider?: StatusProvider;
  db?: Database;
  staticDir?: string | null;
  env?: Record<string, string | undefined>;
  closeoutHome?: string;
  evidenceRoot?: string;
}): ReturnType<typeof Bun.serve> {
  const hostname = options?.hostname ?? "127.0.0.1";
  const port = options?.port ?? 8787;
  const provider = liveProvider(options);
  const staticDir = options && "staticDir" in options ? options.staticDir : defaultStaticDir();
  const env = options?.env;
  return Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const response = await handleStatusRequest(request, {
        provider,
        ...(options?.db ? { db: options.db } : {}),
        staticDir: staticDir ?? null,
        ...(env ? { env } : {}),
        ...(options?.closeoutHome ? { closeoutHome: options.closeoutHome } : {}),
        ...(options?.evidenceRoot ? { evidenceRoot: options.evidenceRoot } : {}),
      });
      if (response) return response;
      return text("Not found", 404);
    },
  });
}

/** The serving process is the dashboard's only data source. */
export function providerFor(options: StatusServerOptions): StatusProvider {
  return liveProvider(options);
}

function liveProvider(options?: {
  sessionIds?: readonly string[];
  provider?: StatusProvider;
  db?: Database;
  env?: Record<string, string | undefined>;
  closeoutHome?: string;
  linearUsage?: LiveStatusOptions["linearUsage"];
  riskApproval?: LiveStatusOptions["riskApproval"];
}): StatusProvider {
  if (options?.provider) return options.provider;
  if (options?.db) {
    return createLiveStatusProvider(options.db, {
      ...(options.sessionIds === undefined ? {} : { sessionIds: options.sessionIds }),
      ...(options.env ? { env: options.env } : {}),
      ...(options.closeoutHome ? { pawsHome: options.closeoutHome } : {}),
      ...(options.linearUsage ? { linearUsage: options.linearUsage } : {}),
      ...(options.riskApproval ? { riskApproval: options.riskApproval } : {}),
    });
  }
  return {
    checkLog: () => null,
    issues: () => emptyIssueList(),
    issue: () => null,
    overview: () => emptyOverview(),
    mergeQueue: () => emptyMergeQueue(),
    questions: () => emptyQuestionList(),
    question: () => null,
    alias: () => null,
    evidence: () => emptyEvidenceList(),
    evidenceMetadata: () => null,
  };
}

function artifactResponse(request: Request, options: StatusServerOptions): Response {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...CORS } });
  if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
  const home = artifactHome(options);
  if (options.db === undefined || home === null) return text("Not found", 404);
  const url = new URL(request.url);
  const read = readCloseoutArtifact({
    ...(options.sessionIds === undefined ? {} : { sessionIds: options.sessionIds }),
    db: options.db,
    itemId: url.searchParams.get("item") ?? "",
    checkId: url.searchParams.get("check") ?? "",
    kind: url.searchParams.get("kind") ?? "",
    head: url.searchParams.get("head") ?? "",
    policy: url.searchParams.get("policy") ?? "",
    evidenceRoot: home,
    ...(options.env ? { env: options.env } : {}),
  });
  return new Response(read.status === 200 ? read.body : "Not found", {
    status: read.status,
    headers: {
      ...CORS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function artifactHome(options: StatusServerOptions): string | null {
  if (options.evidenceRoot !== undefined && options.evidenceRoot.length > 0)
    return options.evidenceRoot;
  const home =
    options.closeoutHome !== undefined && options.closeoutHome.length > 0
      ? options.closeoutHome
      : (options.env ?? process.env).PAWS_HOME;
  if (home !== undefined && home.length > 0) return join(home, "closeout", "evidence");
  return null;
}

/** How long a built resource answers repeated polls before it is built again. */
export const RESOURCE_REUSE_MS = 1_000;

type Built<T> = { value: T } | { error: string };

/**
 * Built resource bodies, per data source, resource, parameters and reader, so a dashboard polling
 * from several tabs builds each body at most once a second. A poll that arrives while one is
 * being built waits for it.
 */
export interface ResourceCache {
  get<T>(source: object, key: string, build: () => Promise<Built<T>>): Promise<Built<T>>;
}

export function createResourceCache(
  options: { now?: () => number; reuseMs?: number } = {},
): ResourceCache {
  const now = options.now ?? Date.now;
  const reuseMs = options.reuseMs ?? RESOURCE_REUSE_MS;
  const sources = new WeakMap<
    object,
    Map<string, { at: number; built: Promise<Built<unknown>> }>
  >();
  return {
    get<T>(source: object, reader: string, build: () => Promise<Built<T>>): Promise<Built<T>> {
      const at = now();
      let readers = sources.get(source);
      if (readers === undefined) sources.set(source, (readers = new Map()));
      for (const [key, entry] of readers) if (at - entry.at >= reuseMs) readers.delete(key);
      const cached = readers.get(reader);
      if (cached !== undefined) return cached.built as Promise<Built<T>>;
      const built = build();
      const entry = { at, built };
      readers.set(reader, entry);
      // A failed build is not reused: the next poll tries again.
      void built.then(
        (result) => {
          if ("error" in result && readers.get(reader) === entry) readers.delete(reader);
        },
        () => {
          if (readers.get(reader) === entry) readers.delete(reader);
        },
      );
      return built;
    },
  };
}

/** The process's cache, shared by every status request the engine serves. */
export const dashboardResources = createResourceCache();

const UNCACHED: ResourceCache = { get: (_source, _key, build) => build() };

/** Status bodies built without a database or provider share this source. */
const EMPTY_SOURCE = {};

function cacheKey(resource: string, parameters: string, options: StatusServerOptions): string {
  const reader = options.sessionIds === undefined ? null : [...options.sessionIds].sort();
  return JSON.stringify([resource, parameters, reader]);
}

async function issuesResponse(
  request: Request,
  options: StatusServerOptions,
  sizes: ResponseSizeJournal,
  cache: ResourceCache,
): Promise<Response> {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...CORS } });
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "Method not allowed" }, 405);
  const provider = providerFor(options);
  const source = options.provider ?? options.db ?? EMPTY_SOURCE;
  const rest = new URL(request.url).pathname.slice(ISSUES_API_PATH.length + 1);
  try {
    if (rest === "") {
      if (provider.issues === undefined) return json({ error: "Not found" }, 404);
      const read = provider.issues.bind(provider);
      const built = await cache.get<IssueListResponse>(
        source,
        cacheKey("issues", "", options),
        async () => {
          const parsed = parseIssueListResponse(await read());
          return parsed.ok ? { value: parsed.response } : { error: parsed.error };
        },
      );
      if ("error" in built) return json({ error: built.error }, 500);
      return conditional(sizes, request, built.value);
    }
    const segments = rest.split("/");
    if (segments.length > 1) return issueCheckLogResponse(request, provider, segments, sizes);
    const id = itemId(segments[0]!);
    if (id === null || provider.issue === undefined) return json({ error: "Not found" }, 404);
    const read = provider.issue.bind(provider);
    const built = await cache.get<IssueDetailResponse | null>(
      source,
      cacheKey("issue", id, options),
      async () => {
        const detail = await read(id);
        if (detail === null) return { value: null };
        const parsed = parseIssueDetailResponse(detail);
        return parsed.ok ? { value: parsed.response } : { error: parsed.error };
      },
    );
    if ("error" in built) return json({ error: built.error }, 500);
    if (built.value === null) return json({ error: "Not found" }, 404);
    return conditional(sizes, request, built.value);
  } catch (caughtError6) {
    journalCaught(caughtError6, "handler.issuesResponse", null);
    return json({ error: "status unavailable" }, 500);
  }
}

async function overviewResponse(
  request: Request,
  options: StatusServerOptions,
  sizes: ResponseSizeJournal,
  cache: ResourceCache,
): Promise<Response> {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...CORS } });
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "Method not allowed" }, 405);
  const provider = providerFor(options);
  if (provider.overview === undefined) return json({ error: "Not found" }, 404);
  const read = provider.overview.bind(provider);
  try {
    const built = await cache.get<OverviewResponse>(
      options.provider ?? options.db ?? EMPTY_SOURCE,
      cacheKey("overview", "", options),
      async () => {
        const parsed = parseOverviewResponse(await read());
        return parsed.ok ? { value: parsed.response } : { error: parsed.error };
      },
    );
    if ("error" in built) return json({ error: built.error }, 500);
    return conditional(sizes, request, built.value);
  } catch (caught) {
    journalCaught(caught, "handler.overviewResponse", null);
    return json({ error: "status unavailable" }, 500);
  }
}

async function mergeQueueResponse(
  request: Request,
  options: StatusServerOptions,
  sizes: ResponseSizeJournal,
  cache: ResourceCache,
): Promise<Response> {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...CORS } });
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "Method not allowed" }, 405);
  const provider = providerFor(options);
  if (provider.mergeQueue === undefined) return json({ error: "Not found" }, 404);
  const read = provider.mergeQueue.bind(provider);
  try {
    const built = await cache.get<MergeQueueResponse>(
      options.provider ?? options.db ?? EMPTY_SOURCE,
      cacheKey("merge-queue", "", options),
      async () => {
        const parsed = parseMergeQueueResponse(await read());
        return parsed.ok ? { value: parsed.response } : { error: parsed.error };
      },
    );
    if ("error" in built) return json({ error: built.error }, 500);
    return conditional(sizes, request, built.value);
  } catch (caughtError7) {
    journalCaught(caughtError7, "handler.mergeQueueResponse", null);
    return json({ error: "status unavailable" }, 500);
  }
}

async function questionsResponse(
  request: Request,
  options: StatusServerOptions,
  sizes: ResponseSizeJournal,
  cache: ResourceCache,
): Promise<Response> {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...CORS } });
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "Method not allowed" }, 405);
  const provider = providerFor(options);
  const source = options.provider ?? options.db ?? EMPTY_SOURCE;
  const rest = new URL(request.url).pathname.slice(QUESTIONS_API_PATH.length + 1);
  try {
    if (rest === "") {
      if (provider.questions === undefined) return json({ error: "Not found" }, 404);
      const read = provider.questions.bind(provider);
      const built = await cache.get<QuestionListResponse>(
        source,
        cacheKey("questions", "", options),
        async () => {
          const parsed = parseQuestionListResponse(await read());
          return parsed.ok ? { value: parsed.response } : { error: parsed.error };
        },
      );
      if ("error" in built) return json({ error: built.error }, 500);
      return conditional(sizes, request, built.value);
    }
    const id = rest.includes("/") ? null : itemId(rest);
    if (id === null || provider.question === undefined) return json({ error: "Not found" }, 404);
    const read = provider.question.bind(provider);
    const built = await cache.get<QuestionDetailResponse | null>(
      source,
      cacheKey("question", id, options),
      async () => {
        const detail = await read(id);
        if (detail === null) return { value: null };
        const parsed = parseQuestionDetailResponse(detail);
        return parsed.ok ? { value: parsed.response } : { error: parsed.error };
      },
    );
    if ("error" in built) return json({ error: built.error }, 500);
    if (built.value === null) return json({ error: "Not found" }, 404);
    return conditional(sizes, request, built.value);
  } catch (caughtError7) {
    journalCaught(caughtError7, "handler.questionsResponse", null);
    return json({ error: "status unavailable" }, 500);
  }
}

const EVIDENCE_METADATA = /^\/([0-9A-HJKMNP-TV-Z]{26})\/metadata$/;

async function evidenceResponse(
  request: Request,
  options: StatusServerOptions,
  sizes: ResponseSizeJournal,
  cache: ResourceCache,
): Promise<Response> {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...CORS } });
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "Method not allowed" }, 405);
  const provider = providerFor(options);
  const source = options.provider ?? options.db ?? EMPTY_SOURCE;
  const rest = new URL(request.url).pathname.slice(EVIDENCE_RESOURCE_PATH.length);
  try {
    if (rest === "") {
      if (provider.evidence === undefined) return json({ error: "Not found" }, 404);
      const read = provider.evidence.bind(provider);
      const built = await cache.get<EvidenceListResponse>(
        source,
        cacheKey("evidence", "", options),
        async () => {
          const parsed = parseEvidenceListResponse(await read());
          return parsed.ok ? { value: parsed.response } : { error: parsed.error };
        },
      );
      if ("error" in built) return json({ error: built.error }, 500);
      return conditional(sizes, request, built.value);
    }
    const id = EVIDENCE_METADATA.exec(rest)?.[1];
    if (id === undefined || provider.evidenceMetadata === undefined)
      return json({ error: "Not found" }, 404);
    const read = provider.evidenceMetadata.bind(provider);
    const built = await cache.get<EvidenceMetadataResponse | null>(
      source,
      cacheKey("evidenceMetadata", id, options),
      async () => {
        const metadata = await read(id);
        if (metadata === null) return { value: null };
        const parsed = parseEvidenceMetadataResponse(metadata);
        return parsed.ok ? { value: parsed.response } : { error: parsed.error };
      },
    );
    if ("error" in built) return json({ error: built.error }, 500);
    if (built.value === null) return json({ error: "Not found" }, 404);
    return conditional(sizes, request, built.value);
  } catch (caughtError7) {
    journalCaught(caughtError7, "handler.evidenceResponse", null);
    return json({ error: "status unavailable" }, 500);
  }
}

async function issueCheckLogResponse(
  request: Request,
  provider: StatusProvider,
  segments: readonly string[],
  sizes: ResponseSizeJournal,
): Promise<Response> {
  const read = await readCheckLog(request, provider, segments);
  if (read === null) return json({ error: "Not found" }, 404);
  const { id, attempt, checkId, run, output, full } = read;
  const stdout = full ? output.stdout : tail(output.stdout);
  const stderr = full ? output.stderr : tail(output.stderr);
  const truncated = stdout !== output.stdout || stderr !== output.stderr;
  const parsed = parseIssueCheckLogResponse({
    generatedAt: new Date().toISOString(),
    stdout,
    stderr,
    truncated,
    fullPath: truncated ? issueCheckLogPath(id, attempt, checkId, { run, full: true }) : null,
  } satisfies IssueCheckLogResponse);
  if (!parsed.ok) return json({ error: parsed.error }, 500);
  return conditional(sizes, request, parsed.response);
}

async function readCheckLog(
  request: Request,
  provider: StatusProvider,
  segments: readonly string[],
): Promise<{
  id: string;
  attempt: number;
  checkId: string;
  run: string | null;
  full: boolean;
  output: CheckOutput;
} | null> {
  const [rawId, attempts, rawAttempt, checks, rawCheck, log] = segments;
  const id = itemId(rawId ?? "");
  const checkId = itemId(rawCheck ?? "");
  const attempt = /^[1-9]\d{0,5}$/.test(rawAttempt ?? "") ? Number(rawAttempt) : null;
  const query = new URL(request.url).searchParams;
  const run = query.get("run");
  if (
    segments.length !== 6 ||
    attempts !== "attempts" ||
    checks !== "checks" ||
    log !== "log" ||
    id === null ||
    checkId === null ||
    attempt === null ||
    (run !== null && !/^[^/\\\0]{1,128}$/.test(run)) ||
    provider.checkLog === undefined
  )
    return null;
  const output = await provider.checkLog({ itemId: id, attempt, checkId, run });
  if (output === null) return null;
  return { id, attempt, checkId, run, full: query.get("full") === "1", output };
}

/** The last `CHECK_LOG_TAIL_BYTES` of `output`, starting on a whole UTF-8 character. */
function tail(output: string): string {
  const bytes = new TextEncoder().encode(output);
  if (bytes.length <= CHECK_LOG_TAIL_BYTES) return output;
  let start = bytes.length - CHECK_LOG_TAIL_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

async function aliasResponse(
  request: Request,
  provider: StatusProvider,
  pathname: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "Method not allowed" }, 405);
  const [kind, raw, ...rest] = pathname.slice(ALIAS_API_PATH.length + 1).split("/");
  const id = itemId(raw ?? "");
  if (!isAliasKind(kind) || id === null || rest.length > 0 || provider.alias === undefined)
    return json({ error: "Not found" }, 404);
  try {
    const issueId = await provider.alias(kind, id);
    if (issueId === null) return json({ error: "Not found" }, 404);
    const body: AliasResponse = { issueId };
    return json(body, 200);
  } catch (caughtError) {
    journalCaught(caughtError, "handler.aliasResponse.alias", null);
    return json({ error: "status unavailable" }, 500);
  }
}

function itemId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return /^[^/\\\0]{1,128}$/.test(id) && id.trim() === id ? id : null;
  } catch (caughtError4) {
    journalCaught(caughtError4, "handler.itemId.decodeURIComponent", null);
    return null;
  }
}

function pageResponse(request: Request, staticDir: string | null, csrfToken?: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
  const url = new URL(request.url);
  const relative = url.pathname === DASHBOARD_PATH ? "index.html" : relativePagePath(url.pathname);
  if (!relative || removedPage(relative)) return text("Not found", 404);
  if (/^runs\/[A-Za-z0-9_-]{1,128}\/transcript\/?$/.test(relative))
    return pageHtml(staticDir, "transcript.html", csrfToken);
  if (relative === "index.html" || !isPublicFile(relative)) return indexHtml(staticDir, csrfToken);
  if (!staticDir) return text("Not found", 404);
  const file = safeFile(staticDir, relative);
  if (!file || !existsSync(file)) {
    if (relative.startsWith("assets/")) return text("Not found", 404);
    return indexHtml(staticDir, csrfToken);
  }
  const cache = relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store";
  return new Response(Bun.file(file), {
    headers: {
      "Content-Type": contentType(file),
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Pages the dashboard no longer has. They 404 instead of falling back to the app. */
const REMOVED_PAGES = ["projects"];

function removedPage(relative: string): boolean {
  const head = relative.split("/")[0];
  return head !== undefined && REMOVED_PAGES.includes(head);
}

function relativePagePath(pathname: string): string | null {
  const prefix = `${DASHBOARD_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw) return "index.html";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch (caughtError2) {
    journalCaught(caughtError2, "handler.relativePagePath.decodeURIComponent", null);
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const normalized = posix.normalize(decoded).replace(/^\.\//, "");
  if (normalized === "" || normalized === ".") return "index.html";
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../"))
    return null;
  return normalized;
}

function isPublicFile(relative: string): boolean {
  return relative === "index.html" || /^assets\/[A-Za-z0-9._-]+$/.test(relative);
}

function safeFile(staticDir: string, relative: string): string | null {
  const root = join(staticDir);
  const target = join(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

function indexHtml(staticDir: string | null, csrfToken?: string): Response {
  return pageHtml(staticDir, "index.html", csrfToken);
}

function pageHtml(staticDir: string | null, name: string, csrfToken?: string): Response {
  const file = staticDir ? safeFile(staticDir, name) : null;
  const body = file && existsSync(file) ? readFileSync(file, "utf8") : MISSING_PAGE;
  return html(injectCsrf(withBase(body), csrfToken));
}

/** Engine pages live at `/dashboard`, so relative asset URLs need that base. */
function withBase(body: string): string {
  const tag = `<base href="${DASHBOARD_PATH}/" />`;
  if (body.includes('<base href="/" />')) return body.replace('<base href="/" />', tag);
  if (body.includes("<base ")) return body;
  if (body.includes("<head>")) return body.replace("<head>", `<head>\n    ${tag}`);
  return `${tag}\n${body}`;
}

function defaultStaticDir(): string | null {
  const dir = join(import.meta.dir, "../../dist");
  return existsSync(join(dir, "index.html")) ? dir : null;
}

function statusEtag(body: { generatedAt: string }): string {
  const { generatedAt: _generatedAt, ...rest } = body;
  return `W/"${createHash("sha256").update(JSON.stringify(rest)).digest("base64url").slice(0, 32)}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function conditional(
  sizes: ResponseSizeJournal,
  request: Request,
  body: { generatedAt: string },
): Response {
  const etag = statusEtag(body);
  const headers = { ETag: etag, [GENERATED_AT_HEADER]: body.generatedAt };
  if (etagMatches(request.headers.get("If-None-Match"), etag))
    return new Response(null, { status: 304, headers: { ...CORS, ...JSON_HEADERS, ...headers } });
  return served(sizes, request, body, headers);
}

/** A 200 JSON body whose size counts toward the minute's largest response. */
function served(
  sizes: ResponseSizeJournal,
  request: Request,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const encoded = JSON.stringify(body);
  sizes.record(new URL(request.url).pathname, Buffer.byteLength(encoded));
  return jsonText(encoded, 200, headers);
}

function json(body: unknown, status: number): Response {
  return jsonText(JSON.stringify(body), status);
}

function jsonText(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...CORS, ...JSON_HEADERS, ...headers },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 307,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function contentType(file: string): string {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "text/html; charset=utf-8";
}

const MISSING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Paws dashboard</title>
</head>
<body>
<p>The Paws dashboard is not built. From the repo root run <code>bun run build:dashboard</code>.</p>
</body>
</html>
`;
