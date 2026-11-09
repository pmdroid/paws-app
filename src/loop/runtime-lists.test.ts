import { expect, test } from "bun:test";
import { createRuntimeLists, RUNTIME_READ_RETRY_MS } from "./runtime-lists";

function fakeMain(toolVersions: Record<string, string>) {
  let head = "a".repeat(40);
  const reads: string[] = [];
  const mains: string[] = [];
  return {
    reads,
    mains,
    move(commit: string, file: string) {
      head = commit;
      toolVersions[commit] = file;
    },
    reader: {
      originMain: () => {
        mains.push("origin");
        return { ok: true as const, commit: head };
      },
      mirrorMain: () => {
        mains.push("mirror");
        return { ok: true as const, commit: head };
      },
      rootFilesAt: (_repo: string, commit: string, names: readonly string[]) => {
        reads.push(commit);
        const files = new Map<string, Uint8Array>();
        if (names.includes(".tool-versions") && toolVersions[commit] !== undefined)
          files.set(".tool-versions", new TextEncoder().encode(toolVersions[commit]));
        return { ok: true as const, files };
      },
    },
  };
}

const names = (list: { runtimes: { tool: string }[] }) => list.runtimes.map((entry) => entry.tool);

test("a follow-up on the same run gets the tools main gained since the run started", async () => {
  const main = fakeMain({ ["a".repeat(40)]: "node 22\n" });
  const lists = createRuntimeLists(main.reader);
  expect(names(await lists.read("acme-item", "run-1", "/acme/widgets"))).toEqual(["node"]);
  main.move("b".repeat(40), "node 22\nkind 0.23.0\n");
  expect(names(await lists.read("acme-item", "run-1", "/acme/widgets"))).toEqual(["node", "kind"]);
});

test("the same run on an unchanged main reads the files once and repeats no notice", async () => {
  const main = fakeMain({ ["a".repeat(40)]: "node 22\nnot-a-tool\n" });
  const lists = createRuntimeLists(main.reader);
  const first = await lists.read("acme-item", "run-1", "/acme/widgets");
  const second = await lists.read("acme-item", "run-1", "/acme/widgets");
  expect(main.reads).toHaveLength(1);
  expect(second.runtimes).toEqual(first.runtimes);
  expect(second.notices).toEqual([]);
});

test("a turn keeps the list of the main it started on when main moves afterwards", async () => {
  const main = fakeMain({ ["a".repeat(40)]: "node 22\n" });
  const lists = createRuntimeLists(main.reader);
  const turn = await lists.read("acme-item", "run-1", "/acme/widgets");
  main.move("b".repeat(40), "node 22\nkind 0.23.0\n");
  expect(names(turn)).toEqual(["node"]);
});

test("a notice already sent on the run is not sent again when main moves", async () => {
  const main = fakeMain({ ["a".repeat(40)]: "node 22\nnot-a-tool\n" });
  const lists = createRuntimeLists(main.reader);
  const first = (await lists.read("acme-item", "run-1", "/acme/widgets")).notices;
  main.move("b".repeat(40), "node 22\nnot-a-tool\nkind 0.23.0\n");
  expect((await lists.read("acme-item", "run-1", "/acme/widgets")).notices).toEqual([]);
  expect((await lists.read("acme-item", "run-2", "/acme/widgets")).notices).toEqual(first);
});

test("a runner-backed item reads main from the mirror's last fetch, not a shared FETCH_HEAD", async () => {
  const main = fakeMain({ ["a".repeat(40)]: "bun 1.4.2\n" });
  const lists = createRuntimeLists(main.reader);
  const list = await lists.read("acme-item", "run-1", "/paws/repos/acme/widgets.git", "mirror");
  expect(list).toEqual({ runtimes: [{ tool: "bun", version: "1.4.2" }], notices: [] });
  expect(main.mains).toEqual(["mirror"]);
});

test("a repository with no runtime files gets no runtimes and no notice", async () => {
  const main = fakeMain({});
  const journal: string[] = [];
  const lists = createRuntimeLists(main.reader, { journal: (line) => journal.push(line) });
  expect(await lists.read("acme-item", "run-1", "/acme/widgets", "mirror")).toEqual({
    runtimes: [],
    notices: [],
  });
  expect(main.reads).toHaveLength(1);
  expect(journal).toEqual([]);
});

test("an unreadable main is retried, then noticed and journaled once per run", async () => {
  const journal: string[] = [];
  const slept: number[] = [];
  let failing = true;
  let attempts = 0;
  const lists = createRuntimeLists(
    {
      originMain: () => ({ ok: true, commit: "a".repeat(40) }),
      mirrorMain: () => {
        attempts++;
        return failing
          ? { ok: false, message: "/paws/repos/acme/widgets.git has no origin/main" }
          : { ok: true, commit: "a".repeat(40) };
      },
      rootFilesAt: () => ({
        ok: true,
        files: new Map([["mise.toml", new TextEncoder().encode('[tools]\nbun = "1.4.2"\n')]]),
      }),
    },
    { journal: (line) => journal.push(line), sleep: async (ms) => void slept.push(ms) },
  );
  const first = await lists.read("acme-item", "run-1", "/paws/repos/acme/widgets.git", "mirror");
  expect(attempts).toBe(RUNTIME_READ_RETRY_MS.length + 1);
  expect(slept).toEqual([...RUNTIME_READ_RETRY_MS]);
  expect(first.runtimes).toEqual([]);
  expect(first.notices).toEqual([
    "Couldn't read mise.toml at origin/main: /paws/repos/acme/widgets.git has no origin/main. Paws sent no runtimes, so tools the repository pins are missing from the agent's PATH.",
  ]);
  expect(journal).toEqual([
    "runtimes item=acme-item run=run-1 unread error=/paws/repos/acme/widgets.git has no origin/main",
  ]);

  const again = await lists.read("acme-item", "run-1", "/paws/repos/acme/widgets.git", "mirror");
  expect(again).toEqual({ runtimes: [], notices: [] });
  expect(journal).toHaveLength(1);

  failing = false;
  expect(await lists.read("acme-item", "run-1", "/paws/repos/acme/widgets.git", "mirror")).toEqual({
    runtimes: [{ tool: "bun", version: "1.4.2" }],
    notices: [],
  });
});

test("a mirror that is not cloned is not retried, and still gets its notice", async () => {
  const journal: string[] = [];
  const slept: number[] = [];
  const lists = createRuntimeLists(
    {
      originMain: () => ({ ok: true, commit: "a".repeat(40) }),
      mirrorMain: () => ({
        ok: false,
        message: "/paws/repos/acme/widgets.git is not cloned",
        absent: true,
      }),
      rootFilesAt: () => ({ ok: true, files: new Map() }),
    },
    { journal: (line) => journal.push(line), sleep: async (ms) => void slept.push(ms) },
  );
  const list = await lists.read("acme-item", "run-1", "/paws/repos/acme/widgets.git", "mirror");
  expect(slept).toEqual([]);
  expect(list.notices).toHaveLength(1);
  expect(journal).toHaveLength(1);
});

const MIRROR = "/paws/repos/acme/widgets.git";
const NOT_CLONED = { ok: false, message: `${MIRROR} is not cloned`, absent: true } as const;
const MISE_FILES = new Map([["mise.toml", new TextEncoder().encode('[tools]\nbun = "1.4.2"\n')]]);

function fakeMirror(afterFetch: Parameters<typeof createRuntimeLists>[0]["mirrorMain"]) {
  const journal: string[] = [];
  const slept: number[] = [];
  let fetches = 0;
  return {
    journal,
    slept,
    fetches: () => fetches,
    fetchMirror: async () => void fetches++,
    lists: createRuntimeLists(
      {
        originMain: () => ({ ok: true, commit: "a".repeat(40) }),
        mirrorMain: (repo) => (fetches ? afterFetch(repo) : NOT_CLONED),
        rootFilesAt: () => ({ ok: true, files: MISE_FILES }),
      },
      { journal: (line) => journal.push(line), sleep: async (ms) => void slept.push(ms) },
    ),
  };
}

test("a mirror that is not built yet is fetched once and its runtimes come back", async () => {
  const mirror = fakeMirror(() => ({ ok: true, commit: "a".repeat(40) }));
  const list = await mirror.lists.read("acme-item", "run-1", MIRROR, "mirror", mirror.fetchMirror);
  expect(list).toEqual({ runtimes: [{ tool: "bun", version: "1.4.2" }], notices: [] });
  expect(mirror.fetches()).toBe(1);
  expect(mirror.slept).toEqual([]);
  expect(mirror.journal).toEqual([]);
});

test("a fetch that still yields no origin/main gets one notice and no retries", async () => {
  const mirror = fakeMirror((repo) => ({ ok: false, message: `${repo} has no origin/main` }));
  const first = await mirror.lists.read("acme-item", "run-1", MIRROR, "mirror", mirror.fetchMirror);
  expect(first.runtimes).toEqual([]);
  expect(first.notices).toEqual([
    `Couldn't read mise.toml at origin/main: ${MIRROR} has no origin/main. Paws sent no runtimes, so tools the repository pins are missing from the agent's PATH.`,
  ]);
  expect(mirror.fetches()).toBe(1);
  expect(mirror.slept).toEqual([]);
  const again = await mirror.lists.read("acme-item", "run-1", MIRROR, "mirror", mirror.fetchMirror);
  expect(again).toEqual({ runtimes: [], notices: [] });
  expect(mirror.journal).toHaveLength(1);
});

test("a fetch that fails is journaled and the run still gets its one notice", async () => {
  const mirror = fakeMirror(() => NOT_CLONED);
  const list = await mirror.lists.read("acme-item", "run-1", MIRROR, "mirror", async () => {
    throw new Error("GitHub sign-in is required.");
  });
  expect(list.notices).toEqual([
    `Couldn't read mise.toml at origin/main: ${MIRROR} is not cloned. Paws sent no runtimes, so tools the repository pins are missing from the agent's PATH.`,
  ]);
  expect(mirror.journal).toEqual([
    "runtimes item=acme-item run=run-1 fetch error=GitHub sign-in is required.",
    `runtimes item=acme-item run=run-1 unread error=${MIRROR} is not cloned`,
  ]);
});
