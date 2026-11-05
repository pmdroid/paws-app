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
      mirrorMain: async () => {
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
      mirrorMain: async () => {
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
