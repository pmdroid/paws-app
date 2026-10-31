import { expect, test } from "bun:test";
import { briefPreviewTemplate } from "./brief-settings";

const settings = {
  template: "Workspace",
  defaultTemplate: "Built-in",
  placeholders: [],
  projects: [
    { repo: "acme/override", template: "Repository" },
    { repo: "acme/inherited", template: null },
  ],
};

test("workspace edits reach inheriting previews while repository overrides win", () => {
  expect(briefPreviewTemplate(settings, "", "Unsaved workspace", "acme/override")).toBe(
    "Repository",
  );
  expect(briefPreviewTemplate(settings, "", "Unsaved workspace", "acme/inherited")).toBe(
    "Unsaved workspace",
  );
});

test("repository drafts apply only to that repository", () => {
  expect(
    briefPreviewTemplate(settings, "acme/override", "Unsaved repository", "acme/override"),
  ).toBe("Unsaved repository");
  expect(
    briefPreviewTemplate(settings, "acme/override", "Unsaved repository", "acme/inherited"),
  ).toBe("Workspace");
  expect(
    briefPreviewTemplate(
      { ...settings, template: null },
      "acme/override",
      "Unsaved repository",
      "acme/inherited",
    ),
  ).toBe("Built-in");
});

test("an unsaved override on an inheriting repository is used for its preview", () => {
  expect(briefPreviewTemplate(settings, "acme/inherited", "New override", "acme/inherited")).toBe(
    "New override",
  );
});
