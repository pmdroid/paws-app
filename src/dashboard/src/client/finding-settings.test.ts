import { expect, test } from "bun:test";
import { renderFindingSettings } from "./finding-settings";
import { SETTINGS_PAGES, renderSettingsPage } from "./settings-pages";

test("the Findings settings page holds the grouping switch", () => {
  expect(SETTINGS_PAGES.map((page) => page.id)).toContain("findings");
  expect(renderSettingsPage("findings")).toContain('id="finding-settings"');
});

test("the switch shows the grouping time when on and what stops when off", () => {
  const on = renderFindingSettings({
    data: { grouping: true, groupingTime: "07:30" },
    busy: null,
    error: null,
  });
  expect(on).toContain('name="finding-grouping" checked');
  expect(on).toContain("Runs at 07:30 UTC.");
  const off = renderFindingSettings({
    data: { grouping: false, groupingTime: "07:30" },
    busy: "Turning grouping off…",
    error: null,
  });
  expect(off).not.toContain("checked");
  expect(off).toContain("disabled");
  expect(off).toContain("Run now is hidden");
});

test("members see who can change it instead of the switch", () => {
  const html = renderFindingSettings({ data: null, busy: null, error: null, denied: true });
  expect(html).toContain("Only workspace admins");
  expect(html).not.toContain("finding-grouping");
});
