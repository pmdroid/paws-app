import { expect, test } from "bun:test";
import { renderSetupChecklist } from "./setup-checklist";

test("the next step adds an agent account in Settings until its binding is healthy", () => {
  const setup = { github: true, runner: true, agent: false, delegated: false };
  const html = renderSetupChecklist(setup);
  expect(html).toContain('aria-current="step"');
  expect(html).toMatch(/aria-current="step">[\s\S]*?<b[^>]*>Add an agent account<\/b>/);
  expect(html).toContain('href="/settings/agent-accounts"');
  expect(html).toContain("A Claude or Codex account Paws uses on your runners");
  const done = renderSetupChecklist({ ...setup, agent: true });
  expect(done).toMatch(/data-setup-step="done">[\s\S]*?Add an agent account/);
  expect(done).not.toContain('href="/settings/agent-accounts"');
});

test("the GitHub App step links to Integrations in Workspace", () => {
  const html = renderSetupChecklist({
    github: false,
    runner: false,
    agent: false,
    delegated: false,
  });
  expect(html).toContain('href="/workspace/integrations"');
  expect(html).not.toContain('href="/settings/integrations"');
});
