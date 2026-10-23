import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { themedMarkup } from "./theme";
import {
  discoversSkills,
  parseSkillSource,
  renderSkillSettings,
  skillSourceGuess,
  type FoundSkill,
  type SkillHook,
  type SkillListing,
} from "./skills";

const TREE = "https://github.com/pbakaus/impeccable/tree/main/.claude/skills/impeccable";

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
      url: "github.com/pmdroid/skills",
    });
    expect(parseSkillSource("git@github.com:pmdroid/skills.git")).toMatchObject({ kind: "git" });
    expect(parseSkillSource("  ")).toBeNull();
  });

  test("a bare owner/repo is GitHub and npm stays reachable as npm:", () => {
    expect(parseSkillSource("pbakaus/impeccable")).toEqual({
      kind: "git",
      url: "pbakaus/impeccable",
    });
    expect(parseSkillSource("npm:impeccable@2.4.1")).toEqual({
      kind: "npm",
      package: "impeccable",
      version: "2.4.1",
    });
  });

  test("reads the ref and subfolder from a GitHub tree or blob URL", () => {
    expect(skillSourceGuess(TREE)).toEqual({ ref: "main", subfolder: ".claude/skills/impeccable" });
    expect(skillSourceGuess(`${TREE}/`)).toEqual({
      ref: "main",
      subfolder: ".claude/skills/impeccable",
    });
    expect(
      skillSourceGuess(
        "https://github.com/pbakaus/impeccable/blob/main/.claude/skills/impeccable/SKILL.md",
      ),
    ).toEqual({ ref: "main", subfolder: ".claude/skills/impeccable" });
    expect(skillSourceGuess("https://github.com/pmdroid/skills/tree/release/1.2/skills/x")).toEqual(
      { ref: "release", subfolder: "1.2/skills/x" },
    );
    expect(skillSourceGuess("https://github.com/pbakaus/impeccable.git")).toEqual({
      ref: "",
      subfolder: "",
    });
    expect(skillSourceGuess("impeccable")).toBeNull();
  });

  test("an untouched guess leaves the split to the server; an owner's change is sent", () => {
    expect(parseSkillSource(TREE, "main", ".claude/skills/impeccable")).toEqual({
      kind: "git",
      url: TREE,
    });
    expect(parseSkillSource(TREE, "v2", ".claude/skills/impeccable")).toEqual({
      kind: "git",
      url: TREE,
      ref: "v2",
      subfolder: ".claude/skills/impeccable",
    });
  });
});

describe("filled-in ref and subfolder", () => {
  const html = markup(
    renderSkillSettings({
      data: listing,
      busy: null,
      error: null,
      notice: null,
      draft: {
        source: TREE,
        ref: "main",
        subfolder: ".claude/skills/impeccable",
        agents: ["claude", "codex"],
      },
    }),
  );

  test("opens the section and shows what was read from the URL", () => {
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).toContain(`value="${TREE}"`);
    expect(html).toContain('value="main"');
    expect(html).toContain('value=".claude/skills/impeccable"');
    expect(html).toContain("A GitHub tree or blob URL fills these in.");
  });

  test("fits a 390 px phone without horizontal scroll", () => {
    const controls = classNames(html, "settings-controls")[0]!;
    expect(controls).toContain("grid-cols-1");
    expect(controls).toContain("sm:grid-cols-2");
    for (const field of classNames(html, "settings-field")) expect(field).toContain("min-w-0");
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  });

  test("a plain source keeps the section closed", () => {
    const closed = renderSkillSettings({ data: listing, busy: null, error: null, notice: null });
    expect(closed).not.toMatch(/<details[^>]*open/);
  });
});

describe("skills found in a repository", () => {
  const found = (skills: FoundSkill[]) =>
    markup(
      renderSkillSettings({
        data: listing,
        busy: null,
        error: null,
        notice: null,
        draft: { source: "pbakaus/impeccable", ref: "", subfolder: "", agents: ["claude"] },
        found: { key: "pbakaus/impeccable", skills },
      }),
    );
  const impeccable: FoundSkill = {
    path: ".claude/skills/impeccable",
    name: "impeccable",
    description: "Use when the user wants to design, redesign, shape, critique, audit, or polish.",
    added: false,
    hooks: [],
  };
  const several: FoundSkill[] = [
    { path: "skills/lint", name: "lint", description: "Lints", added: false, hooks: [] },
    {
      path: "skills/a-review-skill-with-a-rather-long-name-for-a-phone/and/deeper",
      name: "a-review-skill-with-a-rather-long-name-for-a-phone",
      description: "",
      added: false,
      hooks: [],
    },
    { path: "", name: "polish", description: "Polishes", added: true, hooks: [] },
  ];

  test("one skill is listed with its description and path, and preselected", () => {
    const html = found([impeccable]);
    expect(html).toContain("Skills in this repository");
    expect(html).toMatch(/name="skill-pick" checked="" value="\.claude\/skills\/impeccable"/);
    expect(html).toContain("<b>impeccable</b>");
    expect(html).toContain("Use when the user wants to design");
    expect(html).toContain(">.claude/skills/impeccable<");
    expect(html).toContain("Add selected skills");
  });

  test("several skills each get a checkbox and none is preselected", () => {
    const html = found(several);
    expect(html.match(/name="skill-pick"/g)).toHaveLength(3);
    expect(html).not.toMatch(/name="skill-pick" checked/);
    expect(html).toContain('value="skills/lint"');
    expect(html).toContain(">Repository root<");
  });

  test("a skill that is already added says so and stays unchecked", () => {
    const html = found(several);
    expect(html).toMatch(/<b>polish<\/b><span[^>]*>Already added<\/span>/);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*name="skill-pick" value=""/);
    expect(found([impeccable, several[2]!])).toMatch(
      /name="skill-pick" checked="" value="\.claude\/skills\/impeccable"/,
    );
    expect(found([{ ...impeccable, added: true }])).not.toContain('name="skill-pick" checked');
  });

  test("no skill found asks for the folder and opens the subfolder field", () => {
    const html = found([]);
    expect(html).toContain(
      "This repository has no SKILL.md in the usual places. Enter its folder.",
    );
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).not.toContain('name="skill-pick"');
    expect(html).toContain(">Add skill<");
  });

  test("the list fits a 390 px phone without horizontal scroll", () => {
    const html = found([impeccable, ...several]);
    expect(classNames(html, "skill-pick")).toHaveLength(4);
    for (const pick of classNames(html, "skill-pick")) {
      expect(pick).toContain("grid-cols-[auto_minmax(0,1fr)]");
      expect(pick).toContain("min-w-0");
      expect(pick).toContain("[overflow-wrap:anywhere]");
    }
    for (const copy of classNames(html, "skill-pick-copy")) expect(copy).toContain("min-w-0");
    expect(html).toMatch(
      /<b>polish<\/b><span[^>]*class="[^"]*whitespace-normal[^"]*">Already added/,
    );
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  });

  test("a git source without a subfolder looks for skills first", () => {
    const draft = (source: string, subfolder = "") => ({
      source,
      ref: "",
      subfolder,
      agents: ["claude" as const],
    });
    expect(discoversSkills(draft("pbakaus/impeccable"))).toBe(true);
    expect(discoversSkills(draft("https://github.com/pbakaus/impeccable/tree/main"))).toBe(true);
    expect(discoversSkills(draft(TREE))).toBe(false);
    expect(discoversSkills(draft("pbakaus/impeccable", "skills/x"))).toBe(false);
    expect(discoversSkills(draft("impeccable"))).toBe(false);
    expect(discoversSkills(draft(""))).toBe(false);
  });
});

describe("a found skill's own hooks", () => {
  const command =
    '[ ! -f "$PAWS_SKILL_DIR/scripts/impeccable" ] || "$PAWS_SKILL_DIR/scripts/impeccable" hook';
  const hook = (index: number, patch: Partial<SkillHook>): SkillHook => ({
    id: `.claude/skills/impeccable#${index}`,
    source: "Stop",
    event: "stop",
    label: "When the agent stops",
    matcher: null,
    command,
    timeoutSeconds: 30,
    reason: null,
    ...patch,
  });
  const sessionStart = hook(0, {
    source: "SessionStart",
    event: "session_start",
    label: "When a session starts",
    timeoutSeconds: 5,
  });
  const afterEdit = hook(1, {
    source: "PostToolUse Edit|Write",
    event: "after_edit",
    label: "After a file edit",
    timeoutSeconds: 5,
  });
  const stop = hook(2, {});
  const unsupported = hook(3, {
    source: "UserPromptSubmit",
    event: null,
    label: "Not supported",
    timeoutSeconds: 60,
    reason: "Paws has no UserPromptSubmit hook.",
  });
  const skill = (hooks: SkillHook[], patch: Partial<FoundSkill> = {}): FoundSkill => ({
    path: ".claude/skills/impeccable",
    name: "impeccable",
    description: "Design polish",
    added: false,
    hooks,
    ...patch,
  });
  const found = (skills: FoundSkill[]) =>
    markup(
      renderSkillSettings({
        data: listing,
        busy: null,
        error: null,
        notice: null,
        draft: { source: "pbakaus/impeccable", ref: "", subfolder: "", agents: ["claude"] },
        found: { key: "pbakaus/impeccable", skills },
      }),
    );

  test("every supported hook is listed and checked", () => {
    const html = found([skill([sessionStart, afterEdit, stop])]);
    expect(html).toContain("Also add its 3 hooks");
    expect(html.match(/name="skill-hook" checked=""/g)).toHaveLength(3);
    expect(html).toContain('value=".claude/skills/impeccable#1"');
    expect(html).toContain("<b>When a session starts</b>");
    expect(html).toContain("<b>After a file edit</b>");
    expect(html).toContain("<b>When the agent stops</b>");
    expect(html).toContain("PostToolUse Edit|Write · 5s timeout");
    expect(html).toContain("Stop · 30s timeout");
    expect(html).toContain("$PAWS_SKILL_DIR/scripts/impeccable");
    expect(html).not.toContain("Not supported");
  });

  test("a hook Paws cannot run is listed unchecked with the reason", () => {
    const html = found([skill([sessionStart, unsupported, stop])]);
    expect(html).toContain("Also add its 2 hooks");
    expect(html.match(/name="skill-hook" checked=""/g)).toHaveLength(2);
    expect(html).toMatch(
      /<input[^>]*disabled=""[^>]*name="skill-hook" value="\.claude\/skills\/impeccable#3"/,
    );
    expect(html).toMatch(/<span[^>]*>Not supported<\/span>/);
    expect(html).toContain("UserPromptSubmit · 60s timeout");
    expect(html).toContain("Paws has no UserPromptSubmit hook.");
  });

  test("when no hook is supported, none is checked", () => {
    const html = found([skill([unsupported])]);
    expect(html).toContain("None of its hooks can run in Paws");
    expect(html).not.toContain("Also add");
    expect(html).not.toMatch(/name="skill-hook" checked/);
    expect(html).toContain("Paws has no UserPromptSubmit hook.");
  });

  test("skills without hooks or already added offer none; several name their skill", () => {
    expect(found([skill([])])).not.toContain('name="skill-hook"');
    expect(found([skill([stop], { added: true })])).not.toContain('name="skill-hook"');
    const html = found([
      skill([stop]),
      skill([{ ...afterEdit, id: "skills/lint#0" }], { path: "skills/lint", name: "lint" }),
    ]);
    expect(html).toContain("Also add impeccable&#x27;s 1 hook");
    expect(html).toContain("Also add lint&#x27;s 1 hook");
  });

  test("the hook list fits a 390 px phone without horizontal scroll", () => {
    const html = found([skill([sessionStart, afterEdit, stop, unsupported])]);
    expect(classNames(html, "skill-pick")).toHaveLength(5);
    for (const pick of classNames(html, "skill-pick")) {
      expect(pick).toContain("grid-cols-[auto_minmax(0,1fr)]");
      expect(pick).toContain("min-w-0");
      expect(pick).toContain("[overflow-wrap:anywhere]");
    }
    for (const copy of classNames(html, "skill-pick-copy")) expect(copy).toContain("min-w-0");
    expect(html).toMatch(/<span[^>]*class="[^"]*whitespace-normal[^"]*">Not supported/);
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  });
});
