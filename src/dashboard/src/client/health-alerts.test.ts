import { afterEach, describe, expect, test } from "bun:test";
import { emptyOverview } from "../live/overview";
import { parseHealthAlerts, renderHealthAlerts, type HealthAlert } from "./health-alerts";
import { createPageLoader } from "./page-loader";
import { createResourceReader } from "./resource-reader";
import { setSettingsAdmin } from "./settings-pages";

const NOW = "2026-11-27T12:00:00.000Z";
const at = (minutes: number) => Date.parse(NOW) - minutes * 60_000;

const ALERTS: HealthAlert[] = [
  {
    id: "runner_http_4xx:/v1/commands",
    severity: "critical",
    title: "Runner route /v1/commands answered 42 client errors",
    detail: "/v1/commands answered 42 4xx responses in the last 10 minutes.",
    since: at(9),
    count: 42,
  },
  {
    id: "test_timeouts",
    severity: "warning",
    title: "Closeout tests timed out 3 times",
    detail: "Tests <timed> out.",
    since: at(90),
    count: 3,
  },
  {
    id: "idle",
    severity: "info",
    title: "Runners idle",
    detail: "2 free slots.",
    since: at(30),
    count: 2,
  },
];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setSettingsAdmin(false);
});

describe("health alerts banner", () => {
  test("shows each alert with its severity, title, detail, since and count", () => {
    const html = renderHealthAlerts(parseHealthAlerts(ALERTS), NOW);
    expect(html).toContain('aria-label="Health alerts"');
    expect([...html.matchAll(/data-severity="(\w+)"/g)].map((match) => match[1])).toEqual([
      "critical",
      "warning",
      "info",
    ]);
    expect(html).toContain("Critical</span>");
    expect(html).toContain("Runner route /v1/commands answered 42 client errors");
    expect(html).toContain("Tests &lt;timed&gt; out.");
    expect(html).toContain("since 9m ago · count 42");
    expect(html).toContain("since 1h 30m ago · count 3");
  });

  test("renders nothing without alerts", () => {
    expect(renderHealthAlerts([], NOW)).toBe("");
    expect(renderHealthAlerts(undefined, NOW)).toBe("");
  });

  test("drops malformed entries", () => {
    expect(parseHealthAlerts([{ ...ALERTS[0], severity: "loud" }, null, ALERTS[2]])).toEqual([
      ALERTS[2]!,
    ]);
    expect(parseHealthAlerts({ alerts: ALERTS })).toEqual([]);
  });
});

describe("overview alerts loading", () => {
  async function loadOverview(admin: boolean) {
    setSettingsAdmin(admin);
    const fetched: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return Response.json(ALERTS);
    }) as unknown as typeof fetch;
    const pages = createPageLoader({
      reader: () => "reader",
      signedIn: async () => true,
      resources: createResourceReader(async () => Response.json(emptyOverview(new Date(NOW)))),
    });
    expect(await pages.load({ view: "overview" })).toBe("applied");
    return { fetched, alerts: pages.data.alerts };
  }

  test("an admin's overview refresh reads the active alerts", async () => {
    const { fetched, alerts } = await loadOverview(true);
    expect(fetched).toEqual(["/api/alerts"]);
    expect(alerts.map((alert) => alert.severity)).toEqual(["critical", "warning", "info"]);
  });

  test("a member never reads alerts and sees no banner", async () => {
    const { fetched, alerts } = await loadOverview(false);
    expect(fetched).toEqual([]);
    expect(renderHealthAlerts(alerts, NOW)).toBe("");
  });
});
