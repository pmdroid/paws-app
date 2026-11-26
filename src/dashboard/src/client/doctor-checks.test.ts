import { expect, test } from "bun:test";
import { renderDoctorChecks } from "./doctor-checks";

const CHECKS = [
  { name: "git", ok: true, detail: "/usr/bin/git" },
  { name: "linear", ok: false, detail: "not connected", fix: "Open Paws and connect Linear." },
  { name: "database", ok: true, detail: "held", note: true },
];

test("the integrations page lists each check with its fix", () => {
  const html = renderDoctorChecks(CHECKS);
  expect(html).toContain('data-doctor-check="git"');
  expect(html).toContain('<span class="pill ok">OK</span><b>git</b>');
  expect(html).toContain('<span class="pill err">Missing</span><b>linear</b>');
  expect(html).toContain("Open Paws and connect Linear.");
  expect(html).toContain('<span class="pill warn">Note</span><b>database</b>');
  expect(renderDoctorChecks(null, "Workspace admin required.")).toContain(
    'role="alert">Workspace admin required.',
  );
});
