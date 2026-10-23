import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { themedMarkup } from "./theme";
import { parseSkillSource, renderSkillSettings, type SkillListing } from "./skills";

const listing: SkillListing = {
  agents: ["claude", "codex", "grok"],
  limitBytes: 50 * 1024 * 1024,
  updates: {
    "a-review-skill-with-a-rather-long-name-for-a-phone":
      "f0e1d2c3b4a5968778695a4b3c2d1e0f12345678",
  },
  skills: [
    {
      name: "impeccable",
      source: { kind: "npm", package: "impeccable" },
      version: "2.4.1",
      sha256: "a".repeat(64),
      sizeBytes: 2048,
      agents: ["claude", "codex"],
      removedAt: null,
    },
    {
      name: "a-review-skill-with-a-rather-long-name-for-a-phone",
      source: {
        kind: "git",
        url: "https://github.com/pmdroid/a-repository-with-a-long-name-for-skills.git",
        ref: "main",
        subfolder: "skills/review-paws",
      },
      version: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      sha256: "b".repeat(64),
      sizeBytes: 4096,
      agents: ["claude"],
      removedAt: null,
    },
    {
      name: "polish",
      source: { kind: "upload", folder: "polish" },
      version: "0123456789ab",
      sha256: "c".repeat(64),
      sizeBytes: 512,
      agents: ["grok"],
      removedAt: null,
    },
    {
      name: "retired",
      source: { kind: "npm", package: "retired" },
      version: "1.0.0",
      sha256: "d".repeat(64),
      sizeBytes: 512,
      agents: ["claude", "codex", "grok"],
      removedAt: 5,
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

describe("skills section", () => {
  const html = markup(
    renderSkillSettings({ data: listing, busy: null, error: null, notice: null }),
  );

  test("lists each pin with its version, source, agents and checksum", () => {
    expect(html).toContain("<h2");
    expect(html).toContain(">Skills</h2>");
    expect(html).toContain("<b>impeccable</b><span>2.4.1</span>");
    expect(html).toContain("npm impeccable · Claude, Codex");
    expect(html).toContain("sha256 aaaaaaaaaaaa");
    // A commit pin shows short; the source drops the scheme and .git.
    expect(html).toContain("<span>a1b2c3d</span>");
    expect(html).toContain(
      "github.com/pmdroid/a-repository-with-a-long-name-for-skills#main /skills/review-paws · Claude",
    );
    expect(html).toContain('aria-label="Update impeccable"');
    expect(html).toContain('aria-label="Remove impeccable"');
    // An upload has nothing to update from; a removed skill only waits for the runners.
    expect(html).not.toContain('aria-label="Update polish"');
    expect(html).toContain('aria-label="Remove polish"');
    expect(html).toContain("Removing from runners");
    expect(html).not.toContain('aria-label="Remove retired"');
  });

  test("a git skill whose ref moved shows the new short commit", () => {
    expect(html).toMatch(
      /<b>a-review-skill-with-a-rather-long-name-for-a-phone<\/b><span>a1b2c3d<\/span><span[^>]*title="Update moves the pin to f0e1d2c3b4a5968778695a4b3c2d1e0f12345678"[^>]*>Update available · f0e1d2c<\/span>/,
    );
    expect(html.match(/Update available/g)).toHaveLength(1);
  });

  test("the add form takes a source, ref, subfolder, agents, or an uploaded folder", () => {
    expect(html).toContain('placeholder="npm package, git URL, or upload a folder"');
    expect(html).toContain('name="skill-ref"');
    expect(html).toContain('name="skill-subfolder"');
    for (const agent of ["claude", "codex", "grok"])
      expect(html).toContain(`name="skill-agent" checked="" value="${agent}"`);
    expect(html).toContain('type="file"');
    expect(html).toContain("webkitdirectory");
    expect(html).toContain("under 50 MB");
  });

  test("the section fits a 390 px phone without horizontal scroll", () => {
    // One column on phones; the label column only appears from lg.
    const section = classNames(html, "settings-section")[0]!;
    expect(section).toContain("grid-cols-1");
    expect(section).toContain("min-w-0");
    expect(section).toContain("lg:grid-cols-");
    // Long names, URLs and checksums wrap inside the cell instead of widening the table.
    for (const cell of classNames(html, "skill-cell")) {
      expect(cell).toContain("min-w-0");
      expect(cell).toContain("[overflow-wrap:anywhere]");
    }
    for (const name of classNames(html, "skill-name")) expect(name).toContain("flex-wrap");
    // The pin column shrinks to its buttons, which stack until sm.
    // Buttons keep whole words, so the column is as wide as "Remove" and no wider.
    for (const cell of classNames(html, "skill-state")) {
      expect(cell).toContain("w-px");
      expect(cell).toContain("[overflow-wrap:normal]");
    }
    for (const actions of classNames(html, "skill-actions")) {
      expect(actions).toContain("flex-col");
      expect(actions).toContain("sm:flex-row");
    }
    // Agent choices and buttons wrap; no fixed widths anywhere in the section.
    for (const row of classNames(html, "row")) expect(row).toContain("flex-wrap");
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
    // The only unbreakable text is the short removal badge, inside the wrapping name row.
    expect(html.match(/whitespace-nowrap/g)).toHaveLength(1);
    expect(html).toMatch(
      /class="skill-name[^"]*flex-wrap[^"]*"><b>retired<\/b><span>1\.0\.0<\/span><span[^>]*whitespace-nowrap/,
    );
    for (const button of classNames(html, "btn")) expect(button).toContain("whitespace-normal");
  });

  test("members see why they cannot change skills", () => {
    const denied = renderSkillSettings({
      data: null,
      busy: null,
      error: null,
      notice: null,
      denied: true,
    });
    expect(denied).toContain("Only workspace owners and admins can change skills.");
    expect(denied).not.toContain("skill-add-form");
  });

  test("errors and progress are announced", () => {
    const failed = renderSkillSettings({
      data: listing,
      busy: null,
      error: "This source has no SKILL.md at the top of the skill folder.",
      notice: null,
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("no SKILL.md");
    const busy = renderSkillSettings({
      data: listing,
      busy: "Fetching impeccable…",
      error: null,
      notice: null,
    });
    expect(busy).toContain('role="status">Fetching impeccable…');
    expect(busy).toContain("disabled");
  });
});

describe("skill source field", () => {
  test("reads npm packages, versions and git URLs", () => {
    expect(parseSkillSource("impeccable")).toEqual({ kind: "npm", package: "impeccable" });
    expect(parseSkillSource("@acme/skill@1.2.3", "", "skills/a")).toEqual({
      kind: "npm",
      package: "@acme/skill",
      version: "1.2.3",
      subfolder: "skills/a",
    });
    expect(parseSkillSource("https://github.com/pmdroid/skills.git", "v1")).toEqual({
      kind: "git",
      url: "https://github.com/pmdroid/skills.git",
      ref: "v1",
    });
    expect(parseSkillSource("github.com/pmdroid/skills")).toEqual({
      kind: "git",
      url: "https://github.com/pmdroid/skills",
    });
    expect(parseSkillSource("git@github.com:pmdroid/skills.git")).toMatchObject({ kind: "git" });
    expect(parseSkillSource("  ")).toBeNull();
  });
});
