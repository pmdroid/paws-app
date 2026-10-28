import { fullStatusFixture, pageData, statusList, type FullStatus } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { parseStatusSnapshot, type StatusPushOutage } from "../contract";
import type { Route } from "./route";
import { emptyCloseoutView } from "./closeout";
import { render } from "./render";

const OUTAGE: StatusPushOutage = {
  repository: "pmdroid/paws-app",
  since: "2026-10-27T06:59:00.000Z",
  lastError:
    "remote: Permission to pmdroid/paws-app.git denied to paws-helper[bot].\nfatal: unable to access 'https://github.com/pmdroid/paws-app.git/': The requested URL returned error: 403",
  nextProbeAt: "2026-10-27T07:09:00.000Z",
  installationUrl: "https://github.com/settings/installations/22",
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

describe("a GitHub push outage on the dashboard", () => {
  test("the overview and the merge queue show the banner with GitHub's error and the App link", () => {
    const snapshot = { ...fullStatusFixture(), pushOutages: [OUTAGE] };
    for (const route of [{ view: "overview" }, { view: "mergeQueue" }] satisfies Route[]) {
      const html = page(snapshot, route);
      expect(html).toContain('aria-label="Push outage on pmdroid/paws-app"');
      expect(html).toContain(
        "GitHub refuses pushes from the Paws app since 2026-10-27 06:59 UTC. Pushes wait and retry.",
      );
      expect(html).toContain("denied to paws-helper[bot].");
      expect(html).toContain('href="https://github.com/settings/installations/22"');
      expect(html).toContain("Next try at 07:09 UTC");
    }
  });

  test("without an outage nothing is shown", () => {
    const html = page(fullStatusFixture(), { view: "overview" });
    expect(html).not.toContain("push-outage");
  });

  test("the status API carries the outage through the contract", () => {
    const parsed = parseStatusSnapshot(
      JSON.parse(JSON.stringify({ ...statusList(fullStatusFixture()), pushOutages: [OUTAGE] })),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.pushOutages).toEqual([OUTAGE]);
    const broken = parseStatusSnapshot({
      ...statusList(fullStatusFixture()),
      pushOutages: [{ ...OUTAGE, since: "soon" }],
    });
    expect(broken.ok).toBe(false);
  });
});
