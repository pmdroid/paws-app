import { expect, test } from "bun:test";
import { createRuntimeLists } from "./runtime-lists";

function fakeMain(toolVersions: Record<string, string>) {
  let head = "a".repeat(40);
  const reads: string[] = [];
  return {
    reads,
    move(commit: string, file: string) {
      head = commit;
      toolVersions[commit] = file;
    },
    reader: {
      originMain: () => ({ ok: true as const, commit: head }),
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

test("a follow-up on the same run gets the tools main gained since the run started", () => {
  const main = fakeMain({ ["a".repeat(40)]: "node 22\n" });
  const lists = createRuntimeLists(main.reader);
  expect(names(lists.read("acme-item", "run-1", "/acme/widgets"))).toEqual(["node"]);
  main.move("b".repeat(40), "node 22\nkind 0.23.0\n");
  expect(names(lists.read("acme-item", "run-1", "/acme/widgets"))).toEqual(["node", "kind"]);
});

test("the same run on an unchanged main reads the files once and repeats no notice", () => {
  const main = fakeMain({ ["a".repeat(40)]: "node 22\nnot-a-tool\n" });
  const lists = createRuntimeLists(main.reader);
  const first = lists.read("acme-item", "run-1", "/acme/widgets");
  const second = lists.read("acme-item", "run-1", "/acme/widgets");
  expect(main.reads).toHaveLength(1);
  expect(second.runtimes).toEqual(first.runtimes);
  expect(second.notices).toEqual([]);
});

test("a turn keeps the list of the main it started on when main moves afterwards", () => {
  const main = fakeMain({ ["a".repeat(40)]: "node 22\n" });
  const lists = createRuntimeLists(main.reader);
  const turn = lists.read("acme-item", "run-1", "/acme/widgets");
  main.move("b".repeat(40), "node 22\nkind 0.23.0\n");
  expect(names(turn)).toEqual(["node"]);
});

test("a notice already sent on the run is not sent again when main moves", () => {
  const main = fakeMain({ ["a".repeat(40)]: "node 22\nnot-a-tool\n" });
  const lists = createRuntimeLists(main.reader);
  const first = lists.read("acme-item", "run-1", "/acme/widgets").notices;
  main.move("b".repeat(40), "node 22\nnot-a-tool\nkind 0.23.0\n");
  expect(lists.read("acme-item", "run-1", "/acme/widgets").notices).toEqual([]);
  expect(lists.read("acme-item", "run-2", "/acme/widgets").notices).toEqual(first);
});
