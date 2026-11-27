import { mirrorPath } from "../acp";
import {
  diskMirrorMain,
  NOT_FETCHED_MESSAGE,
  policySummary,
  type PolicySummary,
} from "../closeout-spec";
import { closeoutPolicyRoot, loadSettings } from "../config";
import { listWorkspaceRepositoryNamesSteps, type Db } from "../db";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest } from "./handler";

export const CLOSEOUT_SUMMARY_PATH = "/api/settings/closeout-summary";

const CACHE_MS = 5 * 60_000;

export type CloseoutSummaryOptions = {
  store: Db;
  workspaceId: string;
  pawsHome: string;
  home: string;
  trustedOrigin?: string;
  role?: string;
  now?: () => number;
};

type SummaryEntry =
  | {
      repository: string;
      commit: string;
      readAt: number;
      rerun: Extract<PolicySummary, { ok: true }>["rerun"];
      checks: Extract<PolicySummary, { ok: true }>["checks"];
    }
  | { repository: string; commit?: string; readAt: number; error: string };

const cache = new Map<string, SummaryEntry>();

export async function handleCloseoutSummaryRequest(
  request: Request,
  options: CloseoutSummaryOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== CLOSEOUT_SUMMARY_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Closeout settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can read Closeout settings." }, 403);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    const names = await options.store.run((q) =>
      listWorkspaceRepositoryNamesSteps(q, options.workspaceId),
    );
    const config = loadSettings(options.home);
    const now = options.now ?? Date.now;
    const repositories = await Promise.all(
      [...names]
        .sort((a, b) => a.localeCompare(b))
        .map((repository) =>
          summarize(
            repository,
            options.pawsHome,
            closeoutPolicyRoot(config, options.pawsHome, repository),
            now(),
          ),
        ),
    );
    return json({ repositories });
  } catch (error) {
    journalCaught(error, "closeout-summary.handleRequest", null);
    return json({ error: "Closeout settings could not be read" }, 503);
  }
}

async function summarize(
  repository: string,
  pawsHome: string,
  policyRoot: string | undefined,
  now: number,
): Promise<SummaryEntry> {
  const [owner = "", repo = ""] = repository.split("/");
  let path: string;
  try {
    path = mirrorPath(pawsHome, owner, repo);
  } catch (error) {
    journalCaught(error, "closeout-summary.mirrorPath", null);
    return { repository, readAt: now, error: NOT_FETCHED_MESSAGE };
  }
  const main = diskMirrorMain(path);
  const key = JSON.stringify([path, main.ok ? main.commit : null, policyRoot ?? null]);
  const cached = cache.get(key);
  if (cached && now >= cached.readAt && now - cached.readAt < CACHE_MS) return cached;
  const summary = await policySummary(path, undefined, policyRoot);
  const entry: SummaryEntry = summary.ok
    ? {
        repository,
        commit: summary.commit,
        readAt: now,
        rerun: summary.rerun,
        checks: summary.checks,
      }
    : {
        repository,
        ...(summary.commit !== undefined ? { commit: summary.commit } : {}),
        readAt: now,
        error: summary.message,
      };
  for (const [stale, old] of cache) if (now - old.readAt >= CACHE_MS) cache.delete(stale);
  cache.set(key, entry);
  return entry;
}
