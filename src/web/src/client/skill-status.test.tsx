import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStatusSnapshot, STATUS_API_VERSION } from "../contract";
import { runSetupSection } from "./render";
import { runnerDetailMarkup, runnerRowMarkup, runnerSkillsMarkup, type Runner } from "./runners";
import { renderSkillSettings, skillRolloutMarkup, type SkillListing } from "./skills";
import { themedMarkup } from "./theme";

const now = 1_000_000_000;
const commit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const skills: NonNullable<Runner["skills"]> = [
  {
    name: "impeccable",
    version: "2.4.1",
    installedVersion: "2.4.1",
    state: "up_to_date",
    error: null,
    reportedAt: now,
  },
  {
    name: "review-paws",
    version: commit,
    installedVersion: null,
    state: "installing",
    error: null,
    reportedAt: null,
  },
  {
    name: "polish",
    version: "1.3.0",
    installedVersion: "1.2.0",
    state: "out_of_date",
    error: null,
    reportedAt: now,
  },
  {
    name: "a-skill-with-a-rather-long-name-for-a-phone-screen",
    version: "0.9.0",
    installedVersion: null,
    state: "failed",
    error:
      "Skill a-skill-with-a-rather-long-name-for-a-phone-screen 0.9.0 failed its checksum and was not installed.",
    reportedAt: now,
  },
];
const runner: Runner = {
  id: "01JRUNNER0000000000000000A",
  name: "goldbox",
  ownerUserId: "owner",
  status: "active",
  metrics: null,
  os: null,
  version: "1.2.0",
  idle: true,
  skills,
};

function markup(html: string) {
  return renderToStaticMarkup(<>{themedMarkup(html)}</>);
}

function classNames(html: string, marker: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.split(/\s+/).includes(marker));
}

function expectNoFixedWidths(html: string) {
  expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-(?:[4-9]\d|1\d\d)(?:[\s"])/);
}

describe("runner page skills", () => {
  const html = runnerSkillsMarkup(skills, "goldbox");

  test("lists each skill with its pinned version and state", () => {
    expect(html).toContain(
      '<b>impeccable</b><span class="mono" title="2.4.1">2.4.1</span></span><span class="tag ok">Up to date</span>',
    );
    expect(html).toContain(`<span class="mono" title="${commit}">a1b2c3d</span>`);
    expect(html).toContain('data-skill-state="installing"');
    expect(html).toContain('<span class="tag running">Installing</span>');
    expect(html).toContain("Not reported by this runner yet.");
    expect(html).toContain('<span class="tag warn">Out of date</span>');
    expect(html).toContain("Has 1.2.0. Paws pins 1.3.0.");
    expect(html).toContain('<span class="tag bad">Install failed</span>');
  });

  test("shows the last install error, or says the runner did not report one", () => {
    expect(html).toContain(
      '<p class="runner-skill-error" role="note">Skill a-skill-with-a-rather-long-name-for-a-phone-screen 0.9.0 failed its checksum and was not installed.</p>',
    );
    expect(runnerSkillsMarkup([{ ...skills[3]!, error: null }], "goldbox")).toContain(
      "The runner did not report why.",
    );
    expect(html.match(/runner-skill-error/g)).toHaveLength(1);
  });

  test("the runner card counts what is up to date and the list flags a failed install", () => {
    const detail = runnerDetailMarkup(runner, {
      now,
      serverVersion: "1.2.0",
      policy: null,
      userId: null,
      role: null,
      busy: false,
    });
    expect(detail).toContain('<h3 id="runner-01JRUNNER0000000000000000A-skills">Skills</h3>');
    expect(detail).toContain('<span class="muted">1 of 4 up to date</span>');
    expect(runnerRowMarkup(runner, { now, serverVersion: "1.2.0" })).toContain(
      '<span class="tag bad">Skill install failed</span>',
    );
    const { skills: _, ...older } = runner;
    expect(
      runnerDetailMarkup(older, {
        now,
        serverVersion: null,
        policy: null,
        userId: null,
        role: null,
        busy: false,
      }),
    ).not.toContain("-skills");
    expect(runnerSkillsMarkup([], "goldbox")).toContain("No skills registered.");
  });

  test("fits a 390 px phone without horizontal scroll", () => {
    const themed = markup(html);
    for (const row of classNames(themed, "runner-skill")) {
      expect(row).toContain("min-w-0");
      expect(row).toContain("grid-cols-[minmax(0,1fr)_auto]");
      expect(row).toContain("[overflow-wrap:anywhere]");
    }
    for (const name of classNames(themed, "runner-skill-name")) expect(name).toContain("flex-wrap");
    expect(classNames(themed, "runner-skill-list")[0]).toContain("min-w-0");
    expect(themed).toMatch(/class="runner-skill[^"]*\[&amp;&gt;p\]:col-span-full/);
    expectNoFixedWidths(themed);
  });
});

describe("skills waiting on running items", () => {
  const waiting = { ...skills[1]!, installedVersion: "1.0.0", reportedAt: now, waiting: 2 };
  const detail = (entry: typeof waiting) =>
    runnerDetailMarkup(
      { ...runner, skills: [entry] },
      { now, serverVersion: "1.2.0", policy: null, userId: null, role: null, busy: false },
    );

  test("the runner card says how many running items hold the earlier version", () => {
    expect(detail(waiting)).toContain('<span class="tag running">Waiting</span>');
    expect(detail(waiting)).toContain(
      '<p class="muted">Waiting for 2 running items on goldbox. Has 1.0.0 until they end.</p>',
    );
    expect(detail(waiting)).not.toContain(">Installing</span>");
    expect(detail({ ...waiting, waiting: 1 })).toContain("Waiting for 1 running item on goldbox.");
  });

  test("the skill settings name the runner and the count instead of installing", () => {
    const rollout = {
      name: "review-paws",
      total: 2,
      upToDate: 1,
      installing: [],
      waiting: [{ runner: "goldbox", tasks: 3 }],
      outOfDate: [],
      failed: [],
    };
    const html = skillRolloutMarkup(rollout);
    expect(html).toContain(
      '<span class="tag running wrap">Waiting for 3 running items on goldbox</span>',
    );
    expect(html).not.toContain("installing");
  });
});

describe("skill settings rollout", () => {
  const listing: SkillListing = {
    agents: ["claude", "codex", "grok"],
    limitBytes: 50 * 1024 * 1024,
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
        name: "review-paws",
        source: { kind: "git", url: "https://github.com/pmdroid/skills" },
        version: commit,
        sha256: "b".repeat(64),
        sizeBytes: 4096,
        agents: ["claude"],
        removedAt: null,
      },
    ],
    rollouts: [
      { name: "impeccable", total: 2, upToDate: 2, installing: [], outOfDate: [], failed: [] },
      {
        name: "review-paws",
        total: 2,
        upToDate: 1,
        installing: ["goldbox"],
        outOfDate: [],
        failed: [],
      },
    ],
  };
  const html = markup(
    renderSkillSettings({ data: listing, busy: null, error: null, notice: null }),
  );

  test("each skill shows how many runners are up to date and which ones lag", () => {
    expect(html).toContain(">Runners</th>");
    expect(html).toContain(">2 of 2 up to date</span>");
    expect(html).toContain(">1 of 2 up to date</span>");
    expect(html).toContain(">goldbox installing</span>");
    const behind = skillRolloutMarkup({
      name: "polish",
      total: 4,
      upToDate: 0,
      installing: [],
      outOfDate: ["goldbox"],
      failed: ["kyoto", "osaka", "nara"],
    });
    expect(behind).toContain('<span class="tag bad wrap">3 runners failed</span>');
    expect(behind).toContain('<span class="tag warn wrap">goldbox out of date</span>');
    expect(skillRolloutMarkup({ ...listing.rollouts![0]!, total: 0, upToDate: 0 })).toContain(
      "No runners yet",
    );
    expect(skillRolloutMarkup(undefined)).toBe("");
  });

  test("runner names wrap inside the badge at 390 px", () => {
    for (const tag of classNames(html, "wrap")) {
      expect(tag).toContain("whitespace-normal");
      expect(tag).toContain("[overflow-wrap:anywhere]");
      expect(tag).toContain("max-w-full");
    }
    expect(classNames(html, "wrap")).toHaveLength(1);
    expectNoFixedWidths(html);
  });
});

describe("run page skills and hooks", () => {
  const setup = {
    skills: [
      { name: "impeccable", version: "2.4.1", installing: false },
      { name: "review-paws", version: commit, installing: true },
    ],
    hooks: [{ name: "Paws Closeout", event: "stop" }],
  };

  test("lists the skill versions and hooks the run started with", () => {
    const html = runSetupSection(setup);
    expect(html).toContain('<h2 id="setup-heading">Skills and hooks</h2>');
    expect(html).toContain('<b>impeccable</b><span class="mono" title="2.4.1">2.4.1</span></li>');
    expect(html).toContain(`<b>review-paws</b><span class="mono" title="${commit}">a1b2c3d</span>`);
    expect(html).toContain("The run may have had the earlier version.");
    expect(html).toContain('<b>Paws Closeout</b><span class="muted">When the agent stops</span>');
    const empty = runSetupSection({ skills: [], hooks: [] });
    expect(empty).toContain("No registered skills.");
    expect(empty).toContain("No hooks.");
  });

  test("the snapshot carries the setup to the run page", () => {
    const parsed = parseStatusSnapshot({
      version: STATUS_API_VERSION,
      source: "live",
      generatedAt: "2026-10-22T10:00:00.000Z",
      project: { name: "Paws", team: "PAS", repo: "pmdroid/paws-app", workspace: "kyku" },
      epics: [],
      items: [],
      runs: [
        {
          id: "run-1",
          itemId: "PAS-450",
          state: "running",
          agent: "Claude",
          reviewer: "Codex",
          startedAt: "2026-10-22T09:00:00.000Z",
          attempt: 0,
          summary: "",
          activity: [],
          links: [],
          setup,
        },
      ],
      questions: [],
      verdicts: [],
      mergeQueue: [],
    });
    expect(parsed.ok && parsed.snapshot.runs[0]?.setup).toEqual(setup);
  });

  test("fits a 390 px phone without horizontal scroll", () => {
    const html = markup(runSetupSection(setup));
    const section = classNames(html, "run-setup")[0]!;
    expect(section).toContain("grid-cols-1");
    expect(section).toContain("min-w-0");
    expect(section).toContain("[overflow-wrap:anywhere]");
    expect(section).toContain("sm:grid-cols-");
    for (const item of classNames(html, "run-setup-item")) expect(item).toContain("flex-wrap");
    expectNoFixedWidths(html);
  });
});
