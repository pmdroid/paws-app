import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusPawsUpdate, StatusSnapshot } from "../contract";
import { parseStatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { render } from "./render";
import { themedMarkup } from "./theme";

const waiting: StatusPawsUpdate = {
  target: "b8395a6f00",
  current: "a1b2c3d4e5",
  status: "waiting",
  nowRequested: false,
  error: null,
  waitingFor: 1,
  holding: [{ id: "ENG-102", title: "CSV / JSON formatters", phase: "closeout" }],
};

function overview(snapshot: StatusSnapshot): string {
  return render({
    route: { view: "overview" },
    phase: "ready",
    snapshot,
    via: "engine",
    error: null,
    engineUrl: null,
  }).content;
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classNames(html: string, marker: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.split(/\s+/).includes(marker));
}

describe("Paws update banner", () => {
  test("says what the update waits for, with Update now and Cancel", () => {
    const html = overview({ ...demoStatus(), update: waiting });
    expect(text(html)).toContain("Paws update waiting");
    expect(text(html)).toContain("Updating to b8395a6 when 1 task finishes");
    expect(text(html)).toContain(
      "New work waits until the update. ENG-102 is in Closeout and keeps running.",
    );
    expect(html).toContain('data-action="paws-update-now"');
    expect(html).toContain('data-action="paws-update-cancel"');
    // The banner leads the overview, above the summary and Needs you.
    expect(html.indexOf("update-banner")).toBeLessThan(html.indexOf("overview-summary"));
    // Tasks the viewer cannot see are counted, not named.
    const hidden = text(overview({ ...demoStatus(), update: { ...waiting, waitingFor: 3 } }));
    expect(hidden).toContain("when 3 tasks finish");
    expect(hidden).toContain("2 more running elsewhere.");
  });

  test("shows an update that applies now, and one that failed with its reason", () => {
    const applying = overview({
      ...demoStatus(),
      update: { ...waiting, status: "applying", waitingFor: 0, holding: [] },
    });
    expect(text(applying)).toContain("Paws is updating");
    expect(text(applying)).toContain("Updating to b8395a6 now");
    expect(applying).not.toContain("paws-update-now");

    const failed = overview({
      ...demoStatus(),
      update: { ...waiting, status: "failed", error: "bun install failed: lockfile changed" },
    });
    expect(text(failed)).toContain("Paws update failed");
    expect(text(failed)).toContain("Paws stays on a1b2c3d");
    expect(text(failed)).toContain("bun install failed: lockfile changed");
    expect(text(failed)).toContain("Dismiss");
    expect(failed).not.toContain("paws-update-now");
  });

  test("shows on an empty overview, and the contract reads it", () => {
    const empty = { ...demoStatus(), items: [], runs: [], questions: [], update: waiting };
    expect(text(overview(empty))).toContain("Paws update waiting");
    const parsed = parseStatusSnapshot(
      JSON.parse(JSON.stringify({ ...demoStatus(), update: waiting })),
    );
    expect(parsed.ok && parsed.snapshot.update).toEqual(waiting);
    expect(overview(demoStatus())).not.toContain("update-banner");
  });

  test("fits a 390 px phone without horizontal scroll", () => {
    const html = renderToStaticMarkup(
      <>{themedMarkup(overview({ ...demoStatus(), update: waiting }))}</>,
    );
    // The heading and the buttons wrap onto their own lines instead of widening the page.
    const head = classNames(html, "between")[0]!;
    expect(head).toContain("flex-wrap");
    expect(head).toContain("min-w-0");
    expect(classNames(html, "update-card")[0]).toContain("min-w-0");
    // The count keeps its box; the text takes the rest and breaks long words.
    expect(classNames(html, "update-count")[0]).toContain("shrink-0");
    const copy = classNames(html, "update-copy")[0]!;
    expect(copy).toContain("min-w-0");
    expect(copy).toContain("break-words");
    // No fixed widths anywhere in the banner.
    const banner = html.slice(html.indexOf("update-banner"), html.indexOf("overview-summary"));
    expect(banner).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
    expect(banner).not.toContain("whitespace-nowrap");
  });
});
