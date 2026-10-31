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
      writeBriefTemplates(path, {
        template: "Second",
        projects: { "a/b": defaultBriefTemplate() },
      });
      expect(resolveBriefTemplate(loadConfigFile(path), "a/b")).toBe(defaultBriefTemplate());
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
          repository: "a/b",
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
          repository: "a/b",
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
          repository: "a/b",
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
        audit: (action: string, subject: string) => audit.push(`${action}: ${subject}`),
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
      expect((await put({ template: "Workspace" }))?.status).toBe(200);
      expect((await put({ repo: "a/b", template: defaultBriefTemplate() }))?.status).toBe(200);
      expect(resolveBriefTemplate(loadConfigFile(options.configPath), "a/b")).toBe(
        defaultBriefTemplate(),
      );
      expect((await put({ repo: "a/b", template: null }))?.status).toBe(200);
      expect(resolveBriefTemplate(loadConfigFile(options.configPath), "a/b")).toBe("Workspace");
      expect((await put({ template: null }))?.status).toBe(200);
      expect(resolveBriefTemplate(loadConfigFile(options.configPath), "a/b")).toBeNull();
      expect(audit).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
