import { describe, expect, test } from "bun:test";
import { parseStatusSnapshot, type StatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { emptyCloseoutView } from "./closeout";
import { render } from "./render";

function pausedSnapshot(): StatusSnapshot {
  const snapshot = demoStatus();
  snapshot.runs = snapshot.runs.map((run) =>
    run.id === "r-102"
      ? {
          ...run,
          runner: "agentbox",
          usagePause: { agent: "Claude", resumeAt: "2026-10-21T18:00:00.000Z" },
        }
      : run,
  );
  return snapshot;
}

function runPage(snapshot: StatusSnapshot): string {
  return render({
    route: { view: "runs", id: "r-102" },
    phase: "ready",
    snapshot,
    via: "bundled",
    error: null,
    engineUrl: null,
    closeout: emptyCloseoutView(),
  }).content;
}

describe("run page while the agent waits for its usage limit", () => {
  test("shows Paused · usage limit, the reset time and the place for Resume now and Stop", () => {
    const html = runPage(pausedSnapshot());
    expect(html).toContain("Paused · usage limit");
    expect(html).toContain("paused until 18:00");
    expect(html).toContain('<h2 id="usage-pause-heading">Paused</h2>');
    expect(html).toContain("Claude reached its usage limit. Paws continues at 18:00 UTC.");
    expect(html).toContain("At 18:00 Paws continues the item on runner agentbox.");
    expect(html.match(/id="execution-controls"/g)).toHaveLength(1);
    expect(html.indexOf('id="execution-controls"')).toBeGreaterThan(
      html.indexOf("usage-pause-heading"),
    );
  });

  test("a run without a pause renders as before", () => {
    const html = runPage(demoStatus());
    expect(html).not.toContain("usage limit");
    expect(html).not.toContain("usage-pause");
    expect(html).toContain('id="execution-controls"');
  });

  test("the status contract carries the pause and rejects a bad reset time", () => {
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(pausedSnapshot())));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.runs.find((run) => run.id === "r-102")?.usagePause).toEqual({
      agent: "Claude",
      resumeAt: "2026-10-21T18:00:00.000Z",
    });
    const broken = JSON.parse(JSON.stringify(pausedSnapshot()));
    broken.runs.find((run: { id: string }) => run.id === "r-102").usagePause.resumeAt = "soon";
    expect(parseStatusSnapshot(broken).ok).toBe(false);
  });
});
