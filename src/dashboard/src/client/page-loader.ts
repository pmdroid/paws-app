import {
  EVIDENCE_RESOURCE_PATH,
  evidenceMetadataPath,
  ISSUES_API_PATH,
  MERGE_QUEUE_API_PATH,
  OVERVIEW_API_PATH,
  issuePath,
  parseEvidenceListResponse,
  parseEvidenceMetadataResponse,
  parseIssueDetailResponse,
  parseIssueListResponse,
  parseMergeQueueResponse,
  parseOverviewResponse,
  parseQuestionDetailResponse,
  parseQuestionListResponse,
  questionPath,
  QUESTIONS_API_PATH,
  type EvidenceListResponse,
  type EvidenceMetadataResponse,
  type IssueDetailResponse,
  type IssueListResponse,
  type MergeQueueResponse,
  type OverviewResponse,
  type QuestionDetailResponse,
  type QuestionListResponse,
} from "../contract";
import { journalCaught } from "../journal";
import { createResourceReader, type ResourceReader } from "./resource-reader";
import { routeResource, type Route } from "./route";

export interface PageResources {
  issues: IssueListResponse | null;
  issue: IssueDetailResponse | null;
  overview: OverviewResponse | null;
  mergeQueue: MergeQueueResponse | null;
  questions: QuestionListResponse | null;
  question: QuestionDetailResponse | null;
  missingQuestion: string | null;
  evidenceList: EvidenceListResponse | null;
  evidence: EvidenceMetadataResponse | null;
  missingEvidence: string | null;
}

export type PageLoad = "applied" | "stale" | "signed-out" | { error: string };

export interface PageLoaderOptions {
  reader: () => string;
  signedIn: (response: Response) => Promise<boolean>;
  resources?: ResourceReader;
}

function parseList(input: unknown) {
  const parsed = parseIssueListResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseOverview(input: unknown) {
  const parsed = parseOverviewResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseMergeQueue(input: unknown) {
  const parsed = parseMergeQueueResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseQuestions(input: unknown) {
  const parsed = parseQuestionListResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseQuestion(input: unknown) {
  const parsed = parseQuestionDetailResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseEvidenceList(input: unknown) {
  const parsed = parseEvidenceListResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseEvidence(input: unknown) {
  const parsed = parseEvidenceMetadataResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseDetail(input: unknown) {
  const parsed = parseIssueDetailResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

export function createPageLoader(options: PageLoaderOptions) {
  const resources = options.resources ?? createResourceReader();
  const data: PageResources = {
    issues: null,
    issue: null,
    overview: null,
    mergeQueue: null,
    questions: null,
    question: null,
    missingQuestion: null,
    evidenceList: null,
    evidence: null,
    missingEvidence: null,
  };
  let generation = 0;
  let started = 0;
  let applied = 0;

  async function load(route: Route): Promise<PageLoad> {
    const request = ++started;
    const at = generation;
    const reader = options.reader();
    const current = () => at === generation && reader === options.reader() && request > applied;
    const apply = (change: () => void): PageLoad => {
      if (!current()) return "stale";
      applied = request;
      change();
      return "applied";
    };
    const refused = async (response: Response): Promise<PageLoad> => {
      if (!(await options.signedIn(response))) return "signed-out";
      if (!current()) return "stale";
      applied = request;
      return { error: await errorText(response) };
    };
    try {
      const resource = routeResource(route);
      if (resource === "issue" && route.view === "issues" && route.id !== null) {
        const read = await resources.read(issuePath(route.id), reader, parseDetail);
        if (read.kind === "loaded") return apply(() => (data.issue = read.body));
        if (read.response.status !== 404) return await refused(read.response);
        if (!current()) return "stale";
        const list = await resources.read(ISSUES_API_PATH, reader, parseList);
        if (list.kind === "response") return await refused(list.response);
        return apply(() => {
          data.issue = null;
          data.issues = list.body;
        });
      }
      if (resource === "overview") {
        const read = await resources.read(OVERVIEW_API_PATH, reader, parseOverview);
        if (read.kind === "response") return await refused(read.response);
        return apply(() => (data.overview = read.body));
      }
      if (resource === "mergeQueue") {
        const read = await resources.read(MERGE_QUEUE_API_PATH, reader, parseMergeQueue);
        if (read.kind === "response") return await refused(read.response);
        return apply(() => (data.mergeQueue = read.body));
      }
      if (resource === "issues") {
        const list = await resources.read(ISSUES_API_PATH, reader, parseList);
        if (list.kind === "response") return await refused(list.response);
        return apply(() => (data.issues = list.body));
      }
      if (resource === "questions") {
        const read = await resources.read(QUESTIONS_API_PATH, reader, parseQuestions);
        if (read.kind === "response") return await refused(read.response);
        return apply(() => (data.questions = read.body));
      }
      if (resource === "question" && route.view === "questions" && route.id !== null) {
        const id = route.id;
        const read = await resources.read(questionPath(id), reader, parseQuestion);
        if (read.kind === "response" && read.response.status === 404)
          return apply(() => {
            data.question = null;
            data.missingQuestion = id;
          });
        if (read.kind === "response") return await refused(read.response);
        if (read.body.question.id !== id) throw new Error("The engine returned another question");
        return apply(() => {
          data.question = read.body;
          data.missingQuestion = null;
        });
      }
      if (resource === "evidenceGallery") {
        const read = await resources.read(EVIDENCE_RESOURCE_PATH, reader, parseEvidenceList);
        if (read.kind === "response") return await refused(read.response);
        return apply(() => (data.evidenceList = read.body));
      }
      if (resource === "evidence" && route.view === "evidence" && route.id !== null) {
        const id = route.id;
        const read = await resources.read(evidenceMetadataPath(id), reader, parseEvidence);
        if (read.kind === "response" && read.response.status === 404)
          return apply(() => {
            data.evidence = null;
            data.missingEvidence = id;
          });
        if (read.kind === "response") return await refused(read.response);
        if (read.body.evidence.id !== id) throw new Error("The engine returned other evidence");
        return apply(() => {
          data.evidence = read.body;
          data.missingEvidence = null;
        });
      }
      return "stale";
    } catch (caught) {
      journalCaught(caught, "pageLoader.load.fetch", null);
      if (!current()) return "stale";
      applied = request;
      return { error: caught instanceof Error ? caught.message : "Could not load status" };
    }
  }

  return {
    data,
    load,
    navigate(): void {
      generation += 1;
    },
    reset(): void {
      generation += 1;
      resources.clear();
      data.issues = null;
      data.issue = null;
      data.overview = null;
      data.mergeQueue = null;
      data.questions = null;
      data.question = null;
      data.missingQuestion = null;
      data.evidenceList = null;
      data.evidence = null;
      data.missingEvidence = null;
    },
  };
}

export async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return `Engine responded ${response.status}: ${body.error}`;
    }
  } catch (caughtError3) {
    journalCaught(caughtError3, "pageLoader.errorText.json", null);
  }
  return `Engine responded ${response.status}`;
}
