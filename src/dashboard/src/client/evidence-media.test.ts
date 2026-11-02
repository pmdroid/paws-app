import { expect, test } from "bun:test";
import type { StatusEvidence } from "../contract";
import { galleryHtml } from "./evidence-media";
import { evidencePageHref } from "./evidence";

const HEAD = "7439e989".padEnd(40, "0");
const SCREENS = [
  "Runner card with three sessions · desktop",
  "Runner card with three sessions · 390 px",
  "Idle runner card · desktop",
  "Idle runner card · 390 px",
];
const PUBLISHED = [
  "2026-10-23T15:35:00.000Z",
  "2026-10-23T16:15:00.000Z",
  "2026-10-23T17:56:00.000Z",
];

function shot(id: string, displayName: string, publishedAt: string, headCommit = HEAD) {
  return {
    id,
    itemId: "PAS-545",
    runId: "run",
    checkId: "visual-proof",
    attempt: 1,
    kind: "image",
    mediaType: "image/png",
    displayName,
    sizeBytes: 2048,
    headCommit,
    publishedAt,
    publisher: "Claude",
  } satisfies StatusEvidence;
}

function republished(): StatusEvidence[] {
  return PUBLISHED.flatMap((at, copy) =>
    SCREENS.map((name, index) => shot(`ev-${copy}-${index}`, name, at)),
  );
}

function tiles(html: string): string[] {
  return [...html.matchAll(/data-evidence-tile="([^"]+)"/g)].map((match) => match[1]!);
}

test("12 files that are 4 screens published 3 times show 4 tiles, each folding Earlier versions (2)", () => {
  const html = galleryHtml(republished(), new Map(), null);
  expect(tiles(html)).toEqual(["ev-2-0", "ev-2-1", "ev-2-2", "ev-2-3"]);
  expect(html.match(/<summary[^>]*>Earlier versions \(2\)<\/summary>/g)).toHaveLength(4);
  expect(html.match(/<details[ >]/g)).toHaveLength(4);
  expect(html).not.toMatch(/<details[^>]*\sopen/);
  expect(html).toContain(`href="${evidencePageHref("ev-0-0")}"`);
  expect(html).toContain(`href="${evidencePageHref("ev-1-3")}"`);
  expect(html).toMatch(/data-evidence-filter="all"[^>]*>All <span[^>]*>4<\/span>/);
});

test("a newer head shows its file and folds the earlier head's copy", () => {
  const html = galleryHtml(
    [
      shot("old", "Idle runner card · desktop", PUBLISHED[0]!),
      shot("new", "Idle runner card · desktop", PUBLISHED[1]!, "b".repeat(40)),
    ],
    new Map(),
    null,
  );
  expect(tiles(html)).toEqual(["new"]);
  expect(html).toContain("Earlier versions (1)");
  expect(html).toContain("head 7439e98");
});

test("a screen published once has no Earlier versions fold", () => {
  const html = galleryHtml(
    [shot("only", "Idle runner card · desktop", PUBLISHED[0]!)],
    new Map(),
    null,
  );
  expect(tiles(html)).toEqual(["only"]);
  expect(html).not.toContain("Earlier versions");
});
