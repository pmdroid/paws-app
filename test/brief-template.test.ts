import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, resolveBriefTemplate, writeBriefTemplates } from "../src/config";
import {
  previewBriefValues,
  defaultBriefTemplate,
  renderBriefTemplate,
  renderWorkContext,
} from "../src/core";
import { handleBriefSettingsRequest } from "../src/settings";
import { createFakeTracker } from "../src/linear";

const issue = {
  source: "linear" as const,
  issueId: "id",
  identifier: "PAS-1",
  title: "Title",
  description: "Text {{conversation}}",
  acceptanceCriteria: "Criteria",
};
const input = {
  brief: { issue, epic: null },
  projectOverview: "Overview",
  userUpdates: ["Update"],
  taskContext: "Task",
  sessionContext: "Session",
  activities: [{ text: "Hello" }],
};

describe("brief templates", () => {
  test("default preserves the original work context bytes", () => {
    const expected = [
      `Task brief\n\nUse the issue description and acceptance criteria as the task requirements. The delegation provides context for this child, not additional work items.\n\nIssue: PAS-1: Title\n\nSource: linear; issue ID: id\n\nDescription (including acceptance criteria in the source body):\nText {{conversation}}\n\nAcceptance criteria:\nCriteria`,
      "Overview",
      "User update:\nUpdate",
      "Task",
      "Session",
      `Immutable Linear conversation history:\n${JSON.stringify(input.activities)}`,
    ].join("\n\n");
    expect(renderWorkContext(defaultBriefTemplate(), input)).toBe(expected);
  });
  test("empty sections collapse and issue text remains data", () => {
    expect(
      renderBriefTemplate(
        "{{issue.description}}\n\n{{parent}}\n\nEnd",
        previewBriefValues({ issue, parent: null, projectOverview: "Overview" }),
      ),
    ).toBe("Text {{conversation}}\n\nEnd");
  });
  test("saved workspace and repository templates resolve on each read", () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-test-"));
    try {
      const path = join(dir, "config.toml");
      writeBriefTemplates(path, { template: "First", projects: {} });
      expect(resolveBriefTemplate(loadConfigFile(path), "a/b")).toBe("First");
      writeBriefTemplates(path, { template: "Second", projects: { "a/b": "Override" } });
      expect(resolveBriefTemplate(loadConfigFile(path), "a/b")).toBe("Override");
      expect(resolveBriefTemplate(loadConfigFile(path), "a/c")).toBe("Second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("preview uses the Linear fake and rejects unknown placeholders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-api-"));
    try {
      const fake = createFakeTracker();
      const options = {
        configPath: join(dir, "config.toml"),
        csrfToken: "token",
        readIssue: (identifier: string, signal: AbortSignal) =>
          fake.readBriefIssue(identifier, { signal }),
      };
      const request = (path: string, body: unknown) =>
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "x-paws-csrf": "token", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const invalid = await handleBriefSettingsRequest(
        request("/api/settings/brief/preview", {
          template: "{{bad}}",
          repository: "a/b",
          identifier: "PAS-1",
        }),
        options,
      );
      expect(invalid?.status).toBe(400);
      expect(await invalid?.text()).toContain("bad");
      const missing = await handleBriefSettingsRequest(
        request("/api/settings/brief/preview", {
          template: "{{issue.title}}",
          repository: "a/b",
          identifier: "PAS-1",
        }),
        options,
      );
      expect(missing?.status).toBe(404);
      expect(fake.briefReads).toEqual(["PAS-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
