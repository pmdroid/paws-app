import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { themedMarkup } from "./theme";
import { renderHookSettings, type HookListing } from "./hooks";

const listing: HookListing = {
  events: [
    { id: "after_edit", label: "After a file edit" },
    { id: "before_shell", label: "Before a shell command" },
    { id: "before_tool", label: "Before a tool call" },
    { id: "stop", label: "When the agent stops" },
    { id: "session_start", label: "When a session starts" },
  ],
  agents: ["claude", "codex"],
  skills: [{ name: "guard", agents: ["claude"] }],
  limit: 20,
  hooks: [
    {
      id: "hook_fmt",
      event: "after_edit",
      matcher: null,
      command: "bun run fmt",
      timeoutSeconds: 60,
      agents: ["claude", "codex"],
      skill: null,
    },
    {
      id: "hook_guard",
      event: "before_shell",
      matcher: null,
      command:
        '"$PAWS_SKILL_DIR/scripts/guard-secrets-with-a-long-name-that-would-not-fit-a-phone.sh" --strict --report=/tmp/a-very-long-path',
      timeoutSeconds: 10,
      agents: ["claude"],
      skill: "guard",
    },
    {
      id: "hook_mcp",
      event: "before_tool",
      matcher: "mcp__linear__.*",
      command: "audit-tool",
      timeoutSeconds: 5,
      agents: ["codex"],
      skill: null,
    },
  ],
};

function markup(html: string) {
  return renderToStaticMarkup(<>{themedMarkup(html)}</>);
}

function classNames(html: string, marker: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.split(/\s+/).includes(marker));
}

describe("hooks section", () => {
  const html = markup(renderHookSettings({ data: listing, busy: null, error: null, notice: null }));

  test("lists each hook with its event, command, details and agents", () => {
    expect(html).toContain(">Hooks</h2>");
    expect(html).toContain("Run alongside Paws&#x27;s own Closeout hook.");
    expect(html).toContain("<b>After a file edit</b>");
    expect(html).toContain("bun run fmt");
    expect(html).toContain("60s timeout");
    expect(html).toContain("Skill guard · 10s timeout");
    expect(html).toContain("Tools mcp__linear__.* · 5s timeout");
    expect(html).toContain("Claude, Codex");
    expect(html).toContain('aria-label="Remove hook bun run fmt"');
  });

  test("the add form takes an event, command, matcher, timeout, skill and agents", () => {
    for (const label of [
      "After a file edit",
      "Before a shell command",
      "Before a tool call",
      "When the agent stops",
      "When a session starts",
    ])
      expect(html).toContain(`>${label}</option>`);
    expect(html).toContain('value="session_start"');
    expect(html).toContain('placeholder="Command"');
    expect(html).toContain('name="hook-matcher"');
    expect(html).toContain('name="hook-timeout"');
    expect(html).toContain('<option value="guard">guard</option>');
    for (const agent of ["claude", "codex"])
      expect(html).toContain(`name="hook-agent" checked="" value="${agent}"`);
    expect(html).toContain(">Add hook</button>");
  });

  test("the section fits a 390 px phone without horizontal scroll", () => {
    const section = classNames(html, "settings-section")[0]!;
    expect(section).toContain("grid-cols-1");
    expect(section).toContain("min-w-0");
    expect(section).toContain("lg:grid-cols-");
    // Long commands wrap inside their cell instead of widening the table.
    for (const cell of classNames(html, "skill-cell")) {
      expect(cell).toContain("min-w-0");
      expect(cell).toContain("[overflow-wrap:anywhere]");
    }
    // The agents column only grows to its Remove button.
    for (const cell of classNames(html, "skill-state")) {
      expect(cell).toContain("w-px");
      expect(cell).toContain("[overflow-wrap:normal]");
    }
    for (const row of classNames(html, "row")) expect(row).toContain("flex-wrap");
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
    expect(html).not.toContain("whitespace-nowrap");
    for (const button of classNames(html, "btn")) expect(button).toContain("whitespace-normal");
  });

  test("members see why they cannot change hooks", () => {
    const denied = renderHookSettings({
      data: null,
      busy: null,
      error: null,
      notice: null,
      denied: true,
    });
    expect(denied).toContain("Only workspace admins can change hooks.");
    expect(denied).not.toContain("hook-add-form");
  });

  test("an empty list says Closeout still runs, and errors are announced", () => {
    const empty = renderHookSettings({
      data: { ...listing, hooks: [] },
      busy: null,
      error: "Enter the hook's command.",
      notice: null,
    });
    expect(empty).toContain("Every run still gets Paws's Closeout hook.");
    expect(empty).toContain('role="alert"');
  });
});
