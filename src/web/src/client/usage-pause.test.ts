import { fullStatusFixture, pageData, statusList, type FullStatus } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { parseStatusSnapshot } from "../contract";
import { emptyCloseoutView } from "./closeout";
import { render } from "./render";

function pausedSnapshot(): FullStatus {
  const snapshot = fullStatusFixture();
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

function runPage(snapshot: FullStatus): string {
  return render({
    phase: "ready",
    error: null,
    engineUrl: null,
    closeout: emptyCloseoutView(),
    ...pageData(snapshot, { view: "runs", id: "r-102" }),
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
    const html = runPage(fullStatusFixture());
    expect(html).not.toContain("usage limit");
    expect(html).not.toContain("usage-pause");
    expect(html).toContain('id="execution-controls"');
  });

  test("the status contract carries the pause and rejects a bad reset time", () => {
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(statusList(pausedSnapshot()))));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.runs.find((run) => run.id === "r-102")?.usagePause).toEqual({
      agent: "Claude",
      resumeAt: "2026-10-21T18:00:00.000Z",
    });
    const broken = JSON.parse(JSON.stringify(statusList(pausedSnapshot())));
    broken.runs.find((run: { id: string }) => run.id === "r-102").usagePause.resumeAt = "soon";
    expect(parseStatusSnapshot(broken).ok).toBe(false);
  });
});
