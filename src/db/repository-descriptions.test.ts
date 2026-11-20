import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  clearRepositoryDescriptionSteps,
  replaceRepositoryCatalogSteps,
  repositoryDescriptionsSteps,
  writeRepositoryDescriptionSteps,
  type Db,
  type RepositoryDescriptionSource,
} from "./index";
import { tempStore } from "../../test/pglite";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await tempStore());
});

afterEach(() => close());

function write(text: string, source: RepositoryDescriptionSource, now = 10, repository = "o/r") {
  return db.run((q) =>
    writeRepositoryDescriptionSteps(q, {
      workspaceId: "w",
      repository,
      text,
      source,
      contentHash: source === "github" ? null : `hash-${now}`,
      now,
    }),
  );
}

function read(repositories = ["o/r"], workspaceId = "w") {
  return db.run((q) => repositoryDescriptionsSteps(q, workspaceId, repositories));
}

test("a written description is returned for its repository and survives a catalog refresh", async () => {
  expect(await write("Paws itself.", "paws", 10)).toBe(true);
  expect(await write("Other.", "admin", 11, "o/other")).toBe(true);
  const entry = {
    owner: "o",
    repo: "r",
    remoteUrl: "https://github.com/o/r",
    defaultBranch: "main",
  };
  await db.transaction((q) => replaceRepositoryCatalogSteps(q, [entry], 20));
  await db.transaction((q) => replaceRepositoryCatalogSteps(q, [], 30));
  expect(await read()).toEqual([
    {
      repository: "o/r",
      text: "Paws itself.",
      source: "paws",
      contentHash: "hash-10",
      updatedAt: 10,
    },
  ]);
  expect((await read(["O/R", "o/other", "o/missing"])).map((row) => row.repository)).toEqual([
    "o/other",
    "o/r",
  ]);
  expect(await read(["o/r"], "other-workspace")).toEqual([]);
  expect(await read([])).toEqual([]);
});

test("an admin description is replaced only by another admin write", async () => {
  expect(await write("Written by an admin.", "admin", 10)).toBe(true);
  expect(await write("Written by Paws.", "paws", 20)).toBe(false);
  expect(await write("From GitHub.", "github", 30)).toBe(false);
  expect((await read())[0]).toMatchObject({ text: "Written by an admin.", source: "admin" });
  expect(await write("Admin again.", "admin", 40)).toBe(true);
  expect((await read())[0]).toMatchObject({ text: "Admin again.", updatedAt: 40 });
});

test("an admin write replaces a paws row and a github write does not", async () => {
  expect(await write("Written by Paws.", "paws", 10)).toBe(true);
  expect(await write("From GitHub.", "github", 20)).toBe(false);
  expect((await read())[0]).toMatchObject({ text: "Written by Paws.", source: "paws" });
  expect(await write("Written by an admin.", "admin", 30)).toBe(true);
  expect((await read())[0]).toMatchObject({ text: "Written by an admin.", source: "admin" });
});

test("github rows are replaced by github and paws writes", async () => {
  expect(await write("From GitHub.", "github", 10)).toBe(true);
  expect(await write("Newer from GitHub.", "github", 20)).toBe(true);
  expect(await write("Written by Paws.", "paws", 30)).toBe(true);
  expect((await read())[0]).toMatchObject({ text: "Written by Paws.", source: "paws" });
});

test("text is trimmed with line breaks collapsed and over 300 characters is refused", async () => {
  expect(await write("  First line.\r\n  Second line.\n\nThird.  ", "paws")).toBe(true);
  expect((await read())[0]!.text).toBe("First line. Second line. Third.");
  expect(await write(`  ${"a".repeat(300)}\n`, "admin", 20)).toBe(true);
  await expect(write("a".repeat(301), "admin", 30)).rejects.toThrow(RangeError);
  await expect(write(" \n ", "admin", 40)).rejects.toThrow(RangeError);
  expect((await read())[0]!.text).toBe("a".repeat(300));
});

test("clearing removes the row and a later paws write is stored", async () => {
  expect(await write("Written by an admin.", "admin", 10)).toBe(true);
  await db.run((q) => clearRepositoryDescriptionSteps(q, "w", "O/R"));
  expect(await read()).toEqual([]);
  expect(await write("Written by Paws.", "paws", 20)).toBe(true);
  expect((await read())[0]).toMatchObject({ text: "Written by Paws.", source: "paws" });
});
