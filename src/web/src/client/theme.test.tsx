import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { themedMarkup } from "./theme";
import { render } from "./render";
import { renderConversations, type ConversationModel } from "./conversations";
import { identityLinkMarkup } from "./workspace-identities";
import { linearConnectionMarkup } from "./workspace";
import { demoStatus } from "../demo";

function markup(html: string) {
  return renderToStaticMarkup(<>{themedMarkup(html)}</>);
}

function ready(view: "overview" | "questions" | "runs", id: string | null = null) {
  return render({
    route: { view, id },
    phase: "ready",
    snapshot: demoStatus(),
    via: "bundled",
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
  for (const view of [
    "overview",
    "issues",
    "runs",
    "questions",
    "sessions",
    "settings",
    "runners",
  ] as const) {
    const rendered = render({
      route: { view, id: null },
      phase: "ready",
      snapshot: demoStatus(),
      via: "bundled",
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

test("conversation detail separates plan, file, and task metadata", () => {
  const model: ConversationModel = {
    state: "ready",
    sessions: [
      {
        id: "sess",
        title: "Signed URL delivery",
        stopped: false,
        activeItemId: "answer",
        summary: "Waiting on an expiry",
        planState: "sent",
        delivery: [],
        items: [
          {
            id: "answer",
            identifier: "ENG-103",
            title: "Signed URL delivery",
            state: "awaiting_input",
            mode: "answer",
            response: null,
          },
        ],
        messages: [],
        plan: [{ content: "Read the export delivery path", status: "completed" }],
        questions: [],
        artifacts: [
          {
            id: "file",
            itemId: "answer",
            displayName: "deliver.ts",
            mimeType: "text/plain",
            sizeBytes: 5120,
            state: "uploaded",
            href: "/api/linear/artifacts/file",
          },
        ],
        links: [],
      },
    ],
  };
  const raw = renderConversations(model, "sess");
  expect(raw).toContain('<span class="lin-id">ENG-103</span> <span>Signed URL delivery</span>');
  expect(raw).toContain('<span class="muted">text/plain · 5 KB</span>');
  expect(raw).toContain('class="title-row"');
  const html = markup(raw);
  for (const value of classNames(html, "conversation-row")) {
    expect(value).toContain("flex-col");
    expect(value).toContain("gap-2");
  }
  expect(classNames(html, "title-row")[0]).toContain("items-baseline");
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
  const snapshot = demoStatus();
  const rendered = render({
    route: { view: "issues", id: null },
    phase: "ready",
    snapshot,
    via: "bundled",
    error: null,
    engineUrl: null,
  });
  expect(rendered.content).toContain("Blocked by");
  expect(rendered.content).not.toContain("style=");
  expect(markup(rendered.content)).toContain("divide-y-2");
});
