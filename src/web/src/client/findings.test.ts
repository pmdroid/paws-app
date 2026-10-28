import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_FINDING_FILTER, type FindingView, type FindingsResponse } from "../findings";
import { findingsRequest, renderFindings, type FindingsView } from "./findings";
import { NAVIGATION } from "./navigation";
import { render } from "./render";
import { matchRoute, routePath } from "./route";
import { themedMarkup } from "./theme";

function finding(patch: Partial<FindingView> = {}): FindingView {
  return {
    id: 1,
    repository: "acme/platform",
    path: "src/auth/token.ts",
    lines: "12-14",
    severity: "P1",
    review: "independent-review",
    text: "unchecked null: the handler reads the user before the check.",
    bugClass: "unchecked null",
    why: "pre-existing",
    firstSeenAt: "2026-10-20T08:00:00.000Z",
    lastSeenAt: "2026-10-28T09:30:00.000Z",
    itemCount: 2,
    items: [
      { id: "PAS-12", title: "Rotate tokens" },
      { id: "PAS-9", title: "Sign-in page" },
    ],
    status: "open",
    statusBy: null,
    statusAt: null,
    statusReason: null,
    filedIssue: null,
    ...patch,
  };
}

function data(findings: FindingView[]): FindingsResponse {
  return {
    findings,
    total: findings.length,
    counts: { P0: 0, P1: 1, P2: 3, P3: 0 },
    repositories: ["acme/platform", "acme/web"],
    reviews: ["independent-review", "security-review"],
  };
}

function view(patch: Partial<FindingsView> = {}): FindingsView {
  return {
    data: data([finding()]),
    filter: DEFAULT_FINDING_FILTER,
    busy: false,
    error: null,
    message: "",
    local: true,
    ...patch,
  };
}

describe("Findings page", () => {
  test("is in the navigation at /findings", () => {
    expect(NAVIGATION[0].views).toContain("findings");
    expect(matchRoute("/findings")).toEqual({ view: "findings" });
    expect(routePath({ view: "findings" })).toBe("/findings");
    const page = render({
      route: { view: "findings" },
      phase: "loading",
      snapshot: null,
      detail: null,
      error: null,
      engineUrl: "http://127.0.0.1:8787",
    });
    expect(page.title).toBe("Paws status · Findings");
    expect(page.content).toContain('<div id="findings-page"></div>');
  });

  test("renders counts per severity, the filters and each finding's facts", () => {
    const html = renderFindings(
      view({
        filter: { ...DEFAULT_FINDING_FILTER, repository: "acme/platform", path: "src/auth/" },
      }),
    );
    expect(html).toContain(
      'data-findings-severity="P2" aria-pressed="false"><span>P2</span> <b>3</b>',
    );
    for (const name of ["repository", "severity", "review", "status", "path"])
      expect(html).toContain(`data-findings-filter="${name}"`);
    expect(html).toContain('<option value="acme/platform" selected>acme/platform</option>');
    expect(html).toContain('<option value="security-review">security-review</option>');
    expect(html).toContain('<option value="open" selected>Open</option>');
    expect(html).toContain('value="src/auth/"');
    expect(html).toContain("<code>src/auth/token.ts:12-14</code>");
    expect(html).toContain("unchecked null: the handler reads the user before the check.");
    expect(html).toContain("<span>independent-review</span>");
    expect(html).toContain("<span>unchecked null</span>");
    expect(html).toContain("Reported by 2 issues:");
    expect(html).toContain('href="/issues/PAS-12"');
    expect(html).toContain('href="/issues/PAS-9"');
    expect(html).toContain("First seen 2026-10-20 08:00 UTC, last seen 2026-10-28 09:30 UTC");
    expect(html).toContain('data-finding-dismiss="1"');
    expect(html).not.toContain("File an issue");
    // The markup goes through the dashboard theme.
    expect(() => renderToStaticMarkup(themedMarkup(html))).not.toThrow();
  });

  test("dismissed rows offer Reopen and show who dismissed them and why; filed rows name the issue", () => {
    const html = renderFindings(
      view({
        data: data([
          finding({
            status: "dismissed",
            statusBy: "Ada",
            statusAt: "2026-10-28T10:00:00.000Z",
            statusReason: "Legacy, removed next quarter.",
          }),
          finding({
            id: 2,
            status: "filed",
            filedIssue: "PAS-950",
            statusBy: "Ben",
            statusAt: "2026-10-28T11:00:00.000Z",
          }),
        ]),
      }),
    );
    expect(html).toContain('data-findings-action="reopen" data-finding-id="1"');
    expect(html).toContain("Dismissed by Ada 2026-10-28 10:00 UTC: Legacy, removed next quarter.");
    expect(html).toContain('Filed as <span class="lin-id">PAS-950</span> by Ben');
    expect(html).not.toContain('data-finding-dismiss="');
    // Another origin's engine can be read but not changed.
    expect(renderFindings(view({ local: false }))).not.toContain("data-finding-dismiss");
  });

  test("finding text, paths and reasons from the model are escaped", () => {
    const html = renderFindings(
      view({
        data: data([
          finding({
            text: '<img src=x onerror="alert(1)"> & <script>steal()</script>',
            path: "src/<b>.ts",
            bugClass: "<i>xss</i>",
            status: "dismissed",
            statusReason: "<a href=javascript:alert(1)>x</a>",
            items: [{ id: '"><svg onload=alert(1)>', title: '"><b>' }],
          }),
        ]),
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>.ts");
    expect(html).not.toContain("<i>xss");
    expect(html).not.toContain("<a href=javascript");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;script&gt;");
  });

  test("says when nothing matches, and when the list was cut", () => {
    expect(renderFindings(view({ data: data([]) }))).toContain("No open findings.");
    expect(
      renderFindings(
        view({ data: data([]), filter: { ...DEFAULT_FINDING_FILTER, severity: "P0" } }),
      ),
    ).toContain("No findings match these filters.");
    expect(renderFindings(view({ data: { ...data([finding()]), total: 700 } }))).toContain(
      "Showing the 1 seen last of 700.",
    );
  });

  test("reads with the filters and dismisses with the CSRF token", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      sent.push({ url: String(url), init });
      return Response.json(init.method === "POST" ? { finding: finding() } : data([]));
    }) as unknown as typeof fetch;
    await findingsRequest(
      "http://127.0.0.1:8787",
      { filter: { ...DEFAULT_FINDING_FILTER, severity: "P1", path: "src/" } },
      fake,
    );
    expect(sent[0]!.url).toBe("http://127.0.0.1:8787/api/findings?severity=P1&path=src%2F");
    expect(sent[0]!.init.method).toBeUndefined();

    await findingsRequest(
      "http://127.0.0.1:8787",
      { action: { id: 7, action: "dismiss", reason: "Known." }, csrf: "csrf-token" },
      fake,
    );
    expect(sent[1]!.url).toBe("http://127.0.0.1:8787/api/findings");
    expect(sent[1]!.init.method).toBe("POST");
    expect((sent[1]!.init.headers as Record<string, string>)["x-paws-csrf"]).toBe("csrf-token");
    expect(JSON.parse(String(sent[1]!.init.body))).toEqual({
      id: 7,
      action: "dismiss",
      reason: "Known.",
    });
  });

  test("a refused change surfaces the engine's error", async () => {
    const fake = (async () =>
      Response.json(
        { error: "Only an open finding can be dismissed. Refresh the page." },
        { status: 409 },
      )) as unknown as typeof fetch;
    await expect(
      findingsRequest(
        "http://127.0.0.1:8787",
        { action: { id: 1, action: "dismiss", reason: "x" }, csrf: "c" },
        fake,
      ),
    ).rejects.toThrow("Only an open finding can be dismissed.");
  });
});
