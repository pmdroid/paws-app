import { statusFixture } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStatusSnapshot } from "../contract";
import { drawStrokes, reviewDrawMarkup, reviewShots, type Stroke } from "./review-draw";
import { themedMarkup } from "./theme";

function recorder() {
  const calls: string[] = [];
  const context = {
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    beginPath: () => calls.push("begin"),
    moveTo: (x: number, y: number) => calls.push(`move ${x} ${y}`),
    lineTo: (x: number, y: number) => calls.push(`line ${x} ${y}`),
    stroke: () => calls.push("stroke"),
  };
  return { context, calls };
}

const circle: Stroke[] = [
  [
    [0.25, 0.5],
    [0.5, 0.75],
  ],
  [[0.1, 0.1]],
];

describe("drawing on review screenshots", () => {
  test("marks are stored relative to the image, so they land on the same spot at any size", () => {
    const shown = recorder();
    drawStrokes(shown.context as unknown as CanvasRenderingContext2D, circle, 400, 200);
    expect(shown.calls).toEqual([
      "begin",
      "move 100 100",
      "line 200 150",
      "stroke",
      "begin",
      "move 40 20",
      "line 40 20",
      "stroke",
    ]);
    const full = recorder();
    drawStrokes(full.context as unknown as CanvasRenderingContext2D, circle, 2000, 1000);
    expect(full.calls.slice(1, 3)).toEqual(["move 500 500", "line 1000 750"]);
    expect(full.context.lineWidth / 2000).toBeCloseTo(shown.context.lineWidth / 400);
    expect(full.context.lineCap).toBe("round");
  });

  test("only the review's images can be drawn on, each with its own file", () => {
    const snapshot = statusFixture();
    const item = snapshot.items[0]!;
    const shot = {
      itemId: item.id,
      runId: "r",
      checkId: "visual-proof",
      attempt: 1,
      mediaType: "image/png" as const,
      sizeBytes: 1,
      headCommit: "a".repeat(40),
      publishedAt: snapshot.generatedAt,
      publisher: "Claude",
    };
    snapshot.evidence = [
      { ...shot, id: "one", kind: "image", displayName: "one.png" },
      { ...shot, id: "clip", kind: "video", mediaType: "video/mp4", displayName: "clip.mp4" },
      { ...shot, id: "two", kind: "image", displayName: "two.png" },
    ];
    item.visualReviews = [
      {
        questionId: "q-1",
        checkId: "visual-proof",
        round: 1,
        state: "waiting",
        evidenceIds: ["two", "clip", "one"],
        commit: null,
        askedAt: snapshot.generatedAt,
        answeredBy: null,
        answeredAt: null,
        feedback: null,
      },
    ];
    expect(reviewShots(snapshot, "q-1", null)).toEqual([
      { id: "two", name: "two.png", src: "/api/evidence/two" },
      { id: "one", name: "one.png", src: "/api/evidence/one" },
    ]);
    expect(reviewShots(snapshot, "q-other", null)).toEqual([]);
    item.visualReviews[0]!.marks = [{ id: "mark-1", evidenceId: "one" }];
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed.ok && parsed.snapshot.items[0]!.visualReviews?.[0]?.marks).toEqual([
      { id: "mark-1", evidenceId: "one" },
    ]);
  });

  test("desktop and 390 px: the editor has undo, clear, a note and a canvas that takes touch", () => {
    const shots = [
      { id: "one", name: "one.png", src: "/api/evidence/one" },
      { id: "two", name: "two.png", src: "/api/evidence/two" },
    ];
    const html = renderToStaticMarkup(<>{themedMarkup(reviewDrawMarkup(shots))}</>);
    for (const label of ["Undo", "Clear", "Request changes", "Close"])
      expect(html).toContain(`>${label}</button>`);
    expect(html).toContain("data-draw-canvas");
    expect(html).toContain("Note for the agent");
    expect(html).toContain('data-draw-shot="1" aria-pressed="false"');
    expect(html).toMatch(/<dialog[^>]*class="[^"]*review-draw[^"]*max-w-\[calc\(100%-2rem\)\]/);
    const single = renderToStaticMarkup(<>{themedMarkup(reviewDrawMarkup(shots.slice(0, 1)))}</>);
    expect(single).not.toContain("review-draw-shots");
    const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.review-draw-stage canvas \{[^}]*touch-action: none;/);
    expect(css).toMatch(/\.review-draw-stage img \{[^}]*max-width: 100%;/);
    expect(css).toMatch(/dialog\.review-draw \{[^}]*max-width: min\(64rem, calc\(100% - 1rem\)\);/);
  });
});
