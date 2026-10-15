import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { themedMarkup } from "./theme";
import { render } from "./render";
import { demoStatus } from "../demo";

function markup(html: string) {
  return renderToStaticMarkup(<>{themedMarkup(html)}</>);
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
      selectedCheck: null,
    });
    expect(rendered.content).not.toContain("style=");
    expect(markup(rendered.content).length).toBeGreaterThan(0);
  }
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
    selectedCheck: null,
  });
  expect(rendered.content).toContain("Blocked by");
  expect(rendered.content).not.toContain("style=");
  expect(markup(rendered.content)).toContain("divide-y-2");
});
