import { statusFixture } from "../../test/fixtures";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { themedMarkup } from "./theme";
import { render } from "./render";
import { identityLinkMarkup } from "./workspace-identities";
import { linearConnectionMarkup } from "./workspace";
import { runnerDetailMarkup, type Runner } from "./runners";

function markup(html: string) {
  return renderToStaticMarkup(<>{themedMarkup(html)}</>);
}

function ready(view: "overview" | "questions" | "runs", id: string | null = null) {
  return render({
    route: { view, id },
    phase: "ready",
    snapshot: statusFixture(),
    error: null,
    engineUrl: null,
  });
}

function classNames(html: string, marker: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.split(/\s+/).includes(marker));
}

test("markup renders Neobrutalism components while retaining action hooks and native form fields", () => {
  const html = markup(
    '<form id="settings"><label for="agent">Agent</label><select id="agent" name="agent"><option value="claude">Claude</option><option value="codex" selected>Codex</option></select><label><input type="checkbox" name="inherit" checked>Inherit</label><input name="model" value="test"><button type="submit" data-settings="save">Save</button></form>',
  );
  expect(html).toContain('data-slot="native-select"');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('data-slot="input"');
  expect(html).toContain('data-slot="button"');
  expect(html).toContain('name="agent"');
  expect(html).toContain('value="codex" selected');
  expect(html).toContain('name="inherit"');
  expect(html).toContain('data-settings="save"');
});

test("every dashboard view renders without authored inline styles", () => {
  for (const view of ["overview", "issues", "runs", "questions", "settings", "runners"] as const) {
    const rendered = render({
      route: { view, id: null },
      phase: "ready",
      snapshot: statusFixture(),
      error: null,
      engineUrl: null,
    });
    expect(rendered.content).not.toContain("style=");
    expect(markup(rendered.content).length).toBeGreaterThan(0);
  }
});

test("question options separate the number, label, and recommendation", () => {
  const html = markup(ready("questions").content);
  const options = classNames(html, "opt");
  expect(options.length).toBeGreaterThan(0);
  for (const value of options) {
    expect(value).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(value).toContain("gap-x-3");
    expect(value).not.toContain("py-3");
  }
  expect(classNames(html, "opts")[0]).toContain("gap-1");
  expect(classNames(html, "claim")[0]).toContain("items-center");
  const head = classNames(html, "qh")[0] ?? "";
  expect(head).toContain("items-center");
  expect(head).toContain("grid-cols-[minmax(0,1fr)_auto]");
  expect(head).toContain("[&amp;&gt;.title]:col-span-full");
});

test("overview keeps action rows responsive without delivery columns", () => {
  const html = markup(ready("overview").content);
  const rows = classNames(html, "overview-row");
  expect(rows.length).toBeGreaterThan(0);
  for (const value of rows) {
    expect(value).toContain("flex-wrap");
    expect(value).toContain("justify-between");
  }
  expect(classNames(html, "overview-copy")[0]).toContain("break-words");
  expect(html).not.toContain("overview-columns");
});

test("run checks, transcripts, and stop controls keep their columns aligned", () => {
  const html = markup(ready("runs", "r-101").content);
  const checks = classNames(html, "chk");
  expect(checks.length).toBeGreaterThan(1);
  for (const value of checks) {
    expect(value).toContain("focus-visible:outline-2");
    expect(html).toContain("check-command");
    expect(html).toContain("check-meta");
    expect(value).not.toContain("flex-wrap");
  }
  const lines = classNames(html, "ln");
  expect(lines.length).toBeGreaterThan(0);
  for (const value of lines) {
    expect(value).toContain("grid-cols-[auto_auto_minmax(0,1fr)]");
    expect(value).not.toContain("flex-wrap");
  }
  const action = markup(
    '<div class="row"><button class="btn" type="button">Pause item</button><details><summary>Stop this item</summary><p>Stop this item and keep its branch?</p><button class="btn" type="button">Confirm stop</button></details></div>',
  );
  const summary = action.match(/<summary class="([^"]*)"/)?.[1] ?? "";
  expect(summary).toContain("inline-flex");
  expect(summary).toContain("min-h-control");
  expect(summary).toContain("px-4");
  const details = action.match(/<details class="([^"]*)"/)?.[1] ?? "";
  expect(details).not.toContain("my-2");
  expect(details).toContain("self-start");
});

test("account links and the Linear connection line up in columns", () => {
  const link = identityLinkMarkup({
    id: "identity-jonas-github",
    label: "GitHub username",
    value: "jonas",
    maxLength: 39,
    status: "linked · manual",
    disabled: false,
  });
  expect(link).toContain('for="identity-jonas-github"');
  expect(link.indexOf("GitHub username")).toBeLessThan(link.indexOf("<input"));
  const linked = markup(link);
  expect(classNames(linked, "identity-link")[0]).toContain("grid-cols-[minmax(0,1fr)_9.5rem_auto]");
  expect(classNames(linked, "identity-link")[0]).toContain("[&amp;_label]:col-span-full");
  const linear = linearConnectionMarkup("Acme");
  expect(linear).toContain('class="settings-account"');
  expect(linear).toContain('class="row"');
  expect(linear).toContain(">Acme</span>");
  const connected = markup(linear);
  expect(classNames(connected, "settings-account")[0]).toContain("items-start");
});

test("light appearance does not let the system color scheme paint controls", () => {
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  expect(css).toContain("html.light");
  expect(css).toContain("html.dark");
  expect(css).toContain("appearance: none");
  expect(css).not.toMatch(/@media[^{]*prefers-color-scheme:\s*dark/);
});

test("issues list shows blockers without positioned CSS", () => {
  const snapshot = statusFixture();
  const rendered = render({
    route: { view: "issues", id: null },
    phase: "ready",
    snapshot,
    error: null,
    engineUrl: null,
  });
  expect(rendered.content).toContain("Blocked by");
  expect(rendered.content).not.toContain("style=");
  expect(markup(rendered.content)).toContain("divide-y-2");
});

describe("runner card", () => {
  const now = 1_000_000_000;
  const GB = 1024 ** 3;
  const runner: Runner = {
    id: "01JRUNNER0000000000000000A",
    name: "a-runner-with-a-rather-long-host-name-for-a-phone",
    ownerUserId: "owner",
    status: "active",
    metrics: {
      cpuPercent: 97,
      cpuCount: 16,
      memoryTotalBytes: 28 * GB,
      memoryAvailableBytes: 16 * GB,
      load1: 24.86,
      load5: 10.59,
      load15: 5.98,
      diskTotalBytes: 953 * GB,
      diskFreeBytes: 223 * GB,
      reportedAt: now - 5_000,
    },
    os: { id: "ubuntu", version: "24.04" },
    version: "1.4.0",
    idle: false,
    slots: { used: 3, total: 16 },
    concurrency: { desired: 3, applied: 3, ceiling: 16 },
    agents: [{ agent: "claude", status: "signed_in", checkedAt: now }],
  };
  const card = (patch: Partial<Runner> = {}) =>
    markup(
      runnerDetailMarkup(
        { ...runner, ...patch },
        {
          now,
          serverVersion: "1.4.0",
          policy: { ownerUserId: "owner", sharing: 1 },
          userId: "owner",
          role: "owner",
          busy: false,
        },
      ),
    );

  test("gauges fill to their value, lavender when normal and orange when high", () => {
    const html = card();
    expect(html).toContain('style="width:97%"');
    expect(html).toContain('style="width:43%"');
    const fills = [...html.matchAll(/<span class="([^"]*)" style="width:(\d+)%"/g)];
    expect(fills.map((match) => [match[2], match[1]!.includes("bg-main")])).toEqual([
      ["97", true],
      ["43", false],
      ["77", false],
      ["100", true],
    ]);
    expect(
      html.match(/class="slot-mark h-6[^"]*border-dashed bg-secondary-background/g),
    ).toHaveLength(1);
    const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
    expect(css).toContain("--color-gauge:");
  });

  test("stale gauges fade and lose their color", () => {
    const html = card({ metrics: { ...runner.metrics!, reportedAt: now - 60_000 } });
    expect(classNames(html, "runner-gauges")[0]).toContain("grayscale");
    expect(classNames(html, "runner-gauges")[0]).toContain("opacity-60");
    expect(classNames(card(), "runner-gauges")[0]).not.toContain("grayscale");
  });

  test("the card fits a 390 px phone without horizontal scroll", () => {
    const html = card();
    // Two gauge columns on phones, four from lg; agents and settings stack until sm.
    const gauges = classNames(html, "runner-gauges")[0]!;
    expect(gauges).toContain("grid-cols-2");
    expect(gauges).toContain("lg:grid-cols-4");
    expect(gauges).toContain("min-w-0");
    for (const name of ["runner-agent", "runner-setting"]) {
      expect(classNames(html, name)[0]).toContain("grid-cols-1");
      expect(classNames(html, name)[0]).toContain("sm:grid-cols-[10rem_minmax(0,1fr)]");
    }
    // Every gauge reserves its label and bar rows, so bars in a row line up.
    for (const value of classNames(html, "runner-gauge")) {
      expect(value).toContain("content-start");
      expect(value).toContain("grid-rows-[1.75rem]");
    }
    // Labels never shrink below their text; values and details take the remaining column.
    for (const value of classNames(html, "runner-gauge")) {
      expect(value).toContain("grid-cols-[auto_minmax(0,1fr)]");
      expect(value).toContain("min-w-0");
    }
    // Rows wrap rather than widen the page.
    for (const name of ["runner-meta", "runner-status", "runner-block-head"])
      expect(classNames(html, name)[0]).toContain("flex-wrap");
    expect(classNames(html, "runner-title")[0]).toContain("min-w-0");
    expect(classNames(html, "runner-head")[0]).toContain("min-w-0");
    // The bar takes the column width, and the concurrency field stays compact.
    expect(html).toContain("flex h-4 w-full overflow-hidden");
    expect(classNames(html, "concurrency-input")[0]).toContain("w-16");
    expect(classNames(html, "concurrency-input")[0]).not.toContain("w-full");
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  });
});
