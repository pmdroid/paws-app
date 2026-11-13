import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  journalRetiredProjectSettings,
  loadConfigFile,
  resolveBriefTemplate,
  writeBriefTemplates,
} from "../src/config";
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
  test("the saved workspace template resolves on each read and old repository tables are ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-test-"));
    try {
      const path = join(dir, "config.toml");
      await writeBriefTemplates(path, { template: "First" });
      expect(resolveBriefTemplate(loadConfigFile(path))).toBe("First");
      appendFileSync(path, '\n[brief.projects."a/b"]\ntemplate = "Override"\n');
      expect(resolveBriefTemplate(loadConfigFile(path))).toBe("First");
      const lines: string[] = [];
      journalRetiredProjectSettings(path, (line) => lines.push(line));
      expect(lines).toEqual([
        "brief.projects is no longer supported; using the global brief template",
      ]);
      await writeBriefTemplates(path, { template: "Second" });
      expect(readFileSync(path, "utf8")).not.toContain("brief.projects");
      expect(resolveBriefTemplate(loadConfigFile(path))).toBe("Second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("preview uses the Linear fake and rejects unknown placeholders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-api-"));
    try {
      const fake = createFakeTracker([
        {
          linearIssueId: "parent",
          identifier: "PAS-2",
          title: "Parent",
          description: "Parent context",
          subIssues: [
            {
              linearIssueId: "child",
              identifier: "PAS-1",
              title: "Child",
              description: "Issue {{conversation}}",
            },
          ],
        },
      ]);
      fake.briefParents.set("child", "parent");
      fake.projectOverviews.set("child", { name: "Project", content: "Project context" });
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
          identifier: "PAS-1",
        }),
        options,
      );
      expect(invalid?.status).toBe(400);
      expect(await invalid?.text()).toContain("bad");
      const preview = await handleBriefSettingsRequest(
        request("/api/settings/brief/preview", {
          template:
            "{{issue.description}}\n\n{{parent}}\n\n{{project_overview}}\n\n{{user_updates}}",
          identifier: "PAS-1",
        }),
        options,
      );
      expect(preview?.status).toBe(200);
      const result = (await preview!.json()) as {
        text: string;
        total: number;
        sections: { name: string; characters: number }[];
      };
      expect(result.text).toContain("Issue {{conversation}}");
      expect(result.text).toContain("Delegation context: PAS-2: Parent");
      expect(result.text).toContain("Project overview: Project\n\nProject context");
      expect(result.text).toContain("[Sample] User update:");
      expect(result.total).toBe(result.text.length);
      expect(
        result.sections.find((section) => section.name === "parent")?.characters,
      ).toBeGreaterThan(0);
      const missing = await handleBriefSettingsRequest(
        request("/api/settings/brief/preview", {
          template: "{{issue.title}}",
          identifier: "PAS-3",
        }),
        options,
      );
      expect(missing?.status).toBe(404);
      expect(fake.briefReads).toEqual(["PAS-1", "PAS-3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("save and reset templates with origin, CSRF and audit guards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-settings-"));
    try {
      const audit: string[] = [];
      const options = {
        configPath: join(dir, "config.toml"),
        csrfToken: "token",
        repos: ["a/b"],
        audit: async (action: string, subject: string) => {
          audit.push(`${action}: ${subject}`);
        },
      };
      const put = (body: unknown, token = "token", origin = "http://localhost") =>
        handleBriefSettingsRequest(
          new Request("http://localhost/api/settings/brief", {
            method: "PUT",
            headers: { origin, "x-paws-csrf": token, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          options,
        );
      expect((await put({ template: "Workspace" }, "wrong"))?.status).toBe(403);
      expect((await put({ template: "Workspace" }, "token", "https://evil.example"))?.status).toBe(
        403,
      );
      expect((await put({ template: "{{unknown}}" }))?.status).toBe(400);
      expect((await put({ template: "" }))?.status).toBe(400);
      const saved = await put({ template: "Workspace" });
      expect(saved?.status).toBe(200);
      expect(Object.keys((await saved!.json()) as object).sort()).toEqual([
        "defaultTemplate",
        "placeholders",
        "template",
      ]);
      expect(resolveBriefTemplate(loadConfigFile(options.configPath))).toBe("Workspace");
      expect((await put({ template: null }))?.status).toBe(200);
      expect(resolveBriefTemplate(loadConfigFile(options.configPath))).toBeNull();
      expect(audit).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
