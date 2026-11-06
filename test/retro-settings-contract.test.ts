import { expect, test } from "bun:test";
import {
  compatibleRetroProfile,
  insertRetroVariable,
  RETRO_PROMPT_MAX_CHARS as CLIENT_MAX,
  RETRO_PROMPT_VARIABLES as CLIENT_VARIABLES,
  retroPromptProblem as clientProblem,
  retroScheduleSummary,
  sameRetroDraft,
  type RetroSettingsDraft as ClientDraft,
} from "../src/dashboard/src/retro-settings";
import {
  DEFAULT_RETRO_PROMPT,
  proposedRetroSettings,
  RETRO_PROMPT_MAX_CHARS,
  RETRO_PROMPT_VARIABLES,
  retroPromptProblem,
  type RetroSettingsDraft,
} from "../src/retros";

test("the dashboard checks prompts exactly as the server does", () => {
  expect([...CLIENT_VARIABLES]).toEqual([...RETRO_PROMPT_VARIABLES]);
  expect(CLIENT_MAX).toBe(RETRO_PROMPT_MAX_CHARS);
  for (const prompt of [
    DEFAULT_RETRO_PROMPT,
    "",
    "   ",
    "x".repeat(RETRO_PROMPT_MAX_CHARS + 1),
    "{{digest}}",
    "{{ digest }}",
    "{{}} {{digest}}",
    "{{nope}} {{digest}}",
    "No digest",
    "{{digest}}{{digest}}",
    "{{{digest}}}",
    "{{period} {{digest}}",
    "}} {{digest}}",
  ])
    expect(clientProblem(prompt)).toBe(retroPromptProblem(prompt));
});

test("variables replace the selection and leave the cursor after them", () => {
  expect(insertRetroVariable("ab", 1, 1, "period")).toEqual({ value: "a{{period}}b", cursor: 11 });
  expect(insertRetroVariable("abcd", 1, 3, "digest")).toEqual({
    value: "a{{digest}}d",
    cursor: 11,
  });
  expect(insertRetroVariable("ab", 9, 9, "digest").value).toBe("ab{{digest}}");
});

test("compatibility resets a model or effort the catalog no longer offers", () => {
  const catalogs = [
    {
      agent: "codex" as const,
      updatedAt: 1,
      efforts: [{ id: "medium", name: "Medium" }],
      models: [{ id: "m1", name: "m1", efforts: [{ id: "high", name: "High" }] }],
    },
  ];
  expect(
    compatibleRetroProfile({ agent: "codex", model: "gone", effort: "high" }, catalogs),
  ).toEqual({
    agent: "codex",
    model: null,
    effort: null,
  });
  expect(compatibleRetroProfile({ agent: "codex", model: "m1", effort: "high" }, catalogs)).toEqual(
    {
      agent: "codex",
      model: "m1",
      effort: "high",
    },
  );
  expect(compatibleRetroProfile({ agent: "codex", model: "gone", effort: null }, null)).toEqual({
    agent: "codex",
    model: "gone",
    effort: null,
  });
});

test("the schedule summary makes a paused schedule explicit", () => {
  const draft = proposedRetroSettings(["a/b"]);
  expect(retroScheduleSummary(draft.schedule)).toBe("Every Monday, 09:00 UTC.");
  expect(retroScheduleSummary({ ...draft.schedule, cadence: "paused" })).toContain(
    "only when someone selects Run retro",
  );
  expect(sameRetroDraft(draft, { ...draft, repositories: ["A/B"] })).toBe(true);
});

test("the dashboard draft type accepts the server's settings shape", () => {
  const server: RetroSettingsDraft = proposedRetroSettings(["a/b"]);
  const dashboard: ClientDraft = server;
  const back: RetroSettingsDraft = dashboard;
  expect(back).toEqual(server);
});
