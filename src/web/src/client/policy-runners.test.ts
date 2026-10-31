import { fullStatusFixture, pageData, statusList, type FullStatus } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { parseStatusSnapshot, type StatusPolicyRunnerWarning } from "../contract";
import type { Route } from "./route";
import { emptyCloseoutView } from "./closeout";
import { render } from "./render";

const WARNING: StatusPolicyRunnerWarning = {
  repository: "pmdroid/paws-app",
  policyDigest: `sha256:${"a".repeat(64)}`,
  runnerVersion: "0.1.48",
  keys: [
    { key: "items[].ci", needs: "0.1.49" },
    { key: "items[].recheck", needs: "0.1.49" },
  ],
  checkedAt: "2026-10-28T06:43:00.000Z",
};

function page(snapshot: FullStatus, route: Route): string {
  return render({
    phase: "ready",
    error: null,
    engineUrl: null,
    closeout: emptyCloseoutView(),
    ...pageData(snapshot, route),
  }).content;
}

describe("a runner too old for a Closeout policy key on the dashboard", () => {
  test("the overview and the merge queue name each key and the release it needs", () => {
    const snapshot = { ...fullStatusFixture(), policyRunnerWarnings: [WARNING] };
    for (const route of [{ view: "overview" }, { view: "mergeQueue" }] satisfies Route[]) {
      const html = page(snapshot, route);
      expect(html).toContain(
        'aria-label="Closeout policy needs a newer runner for pmdroid/paws-app"',
      );
      expect(html).toContain("the Closeout policy uses keys runner 0.1.48 does not know.");
      expect(html).toContain("<code>items[].ci</code> needs runner 0.1.49");
      expect(html).toContain("<code>items[].recheck</code> needs runner 0.1.49");
    }
  });

  test("without a warning nothing is shown", () => {
    expect(page(fullStatusFixture(), { view: "overview" })).not.toContain("policy-runners");
  });

  test("the status API carries the warning through the contract", () => {
    const parsed = parseStatusSnapshot(
      JSON.parse(
        JSON.stringify({ ...statusList(fullStatusFixture()), policyRunnerWarnings: [WARNING] }),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.policyRunnerWarnings).toEqual([WARNING]);
    const broken = parseStatusSnapshot({
      ...statusList(fullStatusFixture()),
      policyRunnerWarnings: [{ ...WARNING, keys: [{ key: "items[].ci" }] }],
    });
    expect(broken.ok).toBe(false);
  });
});
