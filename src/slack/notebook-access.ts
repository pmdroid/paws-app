import type { Db } from "../db";
import { slackCaller, slackChannelMembers } from "./api";
import { createSlackAuth, installedSlackTokenSteps, type SlackFetch } from "./oauth";
import { currentSlackLinksSteps } from "./threads";

const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;

type ChannelMembers = { slackUserIds: ReadonlySet<string>; name: string | null };

export function createSlackChannelAccess(options: {
  store: Db;
  home: () => string;
  env: Record<string, string | undefined>;
  fetch?: SlackFetch;
  now?: () => number;
}) {
  const { store, env } = options;
  const slackFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; answer: Promise<ChannelMembers | null> }>();

  async function read(workspaceId: string, channelScopeId: string) {
    const [teamId, channelId, ...rest] = channelScopeId.split(":");
    if (!teamId || !channelId || rest.length > 0) return null;
    const home = options.home();
    const install = await store.run((q) => installedSlackTokenSteps(q, home, workspaceId));
    if (install?.teamId !== teamId) return null;
    const auth = createSlackAuth({ home, db: store, fetch: slackFetch, env, workspaceId });
    const call = slackCaller(slackFetch, await auth.ensureFresh());
    return slackChannelMembers(call, channelId, AbortSignal.timeout(TIMEOUT_MS));
  }

  return {
    members(workspaceId: string, channelScopeId: string): Promise<ChannelMembers | null> {
      const key = `${workspaceId}\n${channelScopeId}`;
      const at = now();
      for (const [stale, entry] of cache) if (at - entry.at >= CACHE_MS) cache.delete(stale);
      const hit = cache.get(key);
      if (hit) return hit.answer;
      const answer = read(workspaceId, channelScopeId);
      cache.set(key, { at, answer });
      answer.catch(() => {
        if (cache.get(key)?.answer === answer) cache.delete(key);
      });
      return answer;
    },
    async slackUserId(workspaceId: string, userId: string): Promise<string | null> {
      const home = options.home();
      const links = await store.run((q) => currentSlackLinksSteps(q, home, workspaceId));
      return links.find((link) => link.userId === userId)?.slackUserId ?? null;
    },
  };
}
