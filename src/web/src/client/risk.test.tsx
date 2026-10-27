import { fullStatusFixture, itemDetail } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStatusItemDetail, type StatusItemRisk } from "../contract";
import { emptyCloseoutView } from "./closeout";
import { render } from "./render";
import { themedMarkup } from "./theme";

const HEAD = "7f65200aa1b2c3d4e5f60718293a4b5c6d7e8f90";

/** The ENG-101 issue page from its item detail, with `risk` as the endpoint sends it. */
function page(risk: StatusItemRisk | null): string {
  const parsed = parseStatusItemDetail(
    JSON.parse(JSON.stringify({ ...itemDetail(fullStatusFixture(), "ENG-101"), risk })),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return render({
    route: { view: "issues", id: "ENG-101" },
    phase: "ready",
    snapshot: null,
    detail: parsed.detail,
    error: null,
    engineUrl: null,
    closeout: emptyCloseoutView(),
  }).content;
}

function card(html: string): string {
  const start = html.indexOf('id="risk-tier"');
  expect(start).toBeGreaterThan(0);
  return html.slice(start, html.indexOf("</section>", start));
}

const high: StatusItemRisk = {
  tier: "high",
  head: HEAD,
  base: "b".repeat(40),
  classifiedAt: "2026-10-27T01:00:00.000Z",
  paths: [
    { path: "infra/main.tf", lists: ["file"] },
    { path: "src/auth/session.ts", lists: ["settings", "file"] },
  ],
  securityReview: { state: "passed", detail: null, head: HEAD },
};

describe("Risk card", () => {
  test("a high tier lists each matched path with the list that matched it", () => {
    const html = card(page(high));
    expect(html).toContain('<span class="tag failed">High</span>');
    expect(html).toContain('Commit <span class="mono">7f65200</span> changes 2 high-risk paths.');
    expect(html).toContain(
      '<li><code>infra/main.tf</code><span class="muted">Matched by .paws/high-risk-paths</span></li>',
    );
    expect(html).toContain(
      '<li><code>src/auth/session.ts</code><span class="muted">Matched by Settings › Merging and .paws/high-risk-paths</span></li>',
    );
    expect(html).toContain("Security review ran: passed.");
  });

  test("a normal tier lists no path and says the security review skipped", () => {
    const html = card(
      page({
        ...high,
        tier: "normal",
        paths: [],
        securityReview: { state: "skipped", detail: "no changed path matches", head: HEAD },
      }),
    );
    expect(html).toContain('<span class="tag passed">Normal</span>');
    expect(html).toContain("changes no high-risk path.");
    expect(html).not.toContain(`class="risk-paths"`);
    expect(html.toLowerCase()).toContain("security review skipped: no high-risk path");
  });

  test("before Paws classifies a head, the card shows the running review alone", () => {
    const html = card(
      page({
        tier: null,
        head: null,
        base: null,
        classifiedAt: null,
        paths: [],
        securityReview: { state: "running", detail: null, head: HEAD },
      }),
    );
    expect(html).toContain('<span class="tag">Not classified</span>');
    expect(html).toContain("Paws classifies the risk when Closeout accepts a commit.");
    expect(html).toContain("Security review running.");
  });

  test("a failed review names its finding, and a policy without one says so", () => {
    expect(
      card(
        page({
          ...high,
          securityReview: { state: "failed", detail: "P1 secret in the agent env.", head: HEAD },
        }),
      ),
    ).toContain("Security review ran: failed: P1 secret in the agent env.");
    expect(card(page({ ...high, securityReview: null }))).toContain(
      "No security review in this repository's Closeout policy.",
    );
  });

  test("a head classified before lists were recorded still lists its paths", () => {
    const html = card(page({ ...high, paths: [{ path: "src/auth/session.ts", lists: [] }] }));
    expect(html).toContain("Matched list not recorded");
  });

  test("no risk block, no card", () => {
    expect(page(null)).not.toContain("risk-tier");
  });

  test("390 px: long paths wrap instead of widening the page", () => {
    const long = `src/${"deeply-nested-directory/".repeat(8)}session.ts`;
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        themedMarkup(page({ ...high, paths: [{ path: long, lists: ["settings"] }] })),
      ),
    );
    expect(html).toContain("risk-paths");
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
    expect(html).not.toMatch(/style="[^"]*width:\s*\d{3,}px/);
  });
});
