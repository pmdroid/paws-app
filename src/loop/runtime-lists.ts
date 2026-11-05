import type { RootFilesLoad } from "../closeout";
import { parseRuntimeFiles, RUNTIME_FILES, type RuntimeList } from "../runtimes";

type OriginMain = { ok: true; commit: string } | { ok: false; message: string; absent?: true };

export type RuntimeListReader = {
  originMain(repo: string): OriginMain;
  mirrorMain(repo: string): OriginMain;
  rootFilesAt(repo: string, commit: string, names: readonly string[]): RootFilesLoad;
};

export const RUNTIME_READ_RETRY_MS = [1_000, 4_000] as const;

type Cached = {
  runId: string;
  mainCommit: string | null;
  list: RuntimeList;
  sent: Set<string>;
  unread: boolean;
};

export function createRuntimeLists(
  reader: RuntimeListReader,
  options: {
    journal?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const cache = new Map<string, Cached>();
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  return {
    async read(
      itemId: string,
      runId: string,
      repo: string,
      source: "checkout" | "mirror" = "checkout",
    ): Promise<RuntimeList> {
      const cached = cache.get(itemId);
      const sameRun = cached?.runId === runId;
      let failure = "";
      for (let attempt = 0; ; attempt++) {
        const main = source === "mirror" ? reader.mirrorMain(repo) : reader.originMain(repo);
        if (main.ok && sameRun && cached.mainCommit === main.commit)
          return { runtimes: cached.list.runtimes, notices: [] };
        const load = main.ok ? reader.rootFilesAt(repo, main.commit, RUNTIME_FILES) : main;
        if (load.ok) {
          const list = parseRuntimeFiles(load.files);
          return remember(main.ok ? main.commit : null, list);
        }
        failure = load.message;
        const delay = RUNTIME_READ_RETRY_MS[attempt];
        if (delay === undefined || (!main.ok && main.absent)) break;
        await sleep(delay);
      }
      if (sameRun && cached.unread) return { runtimes: [], notices: [] };
      options.journal?.(`runtimes item=${itemId} run=${runId} unread error=${failure}`);
      return remember(null, {
        runtimes: [],
        notices: [
          `Couldn't read mise.toml at origin/main: ${failure}. Paws sent no runtimes, so tools the repository pins are missing from the agent's PATH.`,
        ],
      });

      function remember(mainCommit: string | null, list: RuntimeList): RuntimeList {
        const sent = sameRun && cached ? cached.sent : new Set<string>();
        const notices = list.notices.filter((notice) => !sent.has(notice));
        for (const notice of notices) sent.add(notice);
        const unread = mainCommit === null || (sameRun && cached ? cached.unread : false);
        cache.set(itemId, { runId, mainCommit, list, sent, unread });
        return { runtimes: list.runtimes, notices };
      }
    },
  };
}
