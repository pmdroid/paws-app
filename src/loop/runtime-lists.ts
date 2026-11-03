import type { RootFilesLoad } from "../closeout";
import { RUNTIME_FILES, runtimeList, type RuntimeList } from "../runtimes";

type OriginMain = { ok: true; commit: string } | { ok: false; message: string };

export type RuntimeListReader = {
  originMain(repo: string): OriginMain;
  rootFilesAt(repo: string, commit: string, names: readonly string[]): RootFilesLoad;
};

type Cached = { runId: string; mainCommit: string | null; list: RuntimeList; sent: Set<string> };

export function createRuntimeLists(reader: RuntimeListReader) {
  const cache = new Map<string, Cached>();
  return {
    read(itemId: string, runId: string, repo: string): RuntimeList {
      const main = reader.originMain(repo);
      const cached = cache.get(itemId);
      const sameRun = cached?.runId === runId;
      if (sameRun && main.ok && cached.mainCommit === main.commit)
        return { runtimes: cached.list.runtimes, notices: [] };
      const list = runtimeList(
        main.ok ? reader.rootFilesAt(repo, main.commit, RUNTIME_FILES) : main,
      );
      const sent = sameRun ? cached.sent : new Set<string>();
      const notices = list.notices.filter((notice) => !sent.has(notice));
      for (const notice of notices) sent.add(notice);
      cache.set(itemId, { runId, mainCommit: main.ok ? main.commit : null, list, sent });
      return { runtimes: list.runtimes, notices };
    },
  };
}
