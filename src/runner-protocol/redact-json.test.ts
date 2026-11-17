import { expect, test } from "bun:test";
import { redactedJson, redactGitHubTokens } from "./activity";

test("a quoted token-shaped string in agent output still serializes to valid JSON", () => {
  const fixture = 'return Response.json({ access_token: "ghu_fixtureIdentityOnly", scope });';
  expect(JSON.parse(redactedJson({ type: "acp", output: fixture })).output).toBe(fixture);
  const token = `ghu_${"x".repeat(36)}`;
  const line = redactedJson({ type: "acp", output: `access_token: "${token}"` });
  expect(JSON.parse(line).output).toBe('access_token: "[redacted]"');
});

test("an exact read token holding JSON-escaped characters is redacted, not left in the line", () => {
  const token = "ghs_a:b#c-d'e\"f{g}\\h";
  const line = redactedJson({ type: "acp", output: `token ${token} used` }, [token]);
  expect(line).not.toContain("ghs_a:b");
  expect(JSON.parse(line).output).toBe("token [redacted] used");
});

test("the token pattern stops at a backslash", () => {
  const token = `ghp_${"a".repeat(24)}`;
  expect(redactGitHubTokens(`${token}\\n next`)).toBe("[redacted]\\n next");
});

test("Paws access and refresh tokens are redacted in strings and nested records", () => {
  for (const prefix of ["paws_at_", "paws_rt_"]) {
    const token = `${prefix}${"Ab3".repeat(14)}x`;
    expect(redactGitHubTokens(`token ${token} used`)).toBe("token [redacted] used");
    const line = redactedJson({ type: "acp", output: { nested: [{ value: `Bearer ${token}` }] } });
    expect(line).not.toContain(prefix);
    expect(JSON.parse(line).output.nested[0].value).toBe("Bearer [redacted]");
  }
});

test("names that start with paws_ or PAWS_ are left alone", () => {
  const text = "PAWS_EVIDENCE_DIR=paws_evidence_dir PAWS_HOME=/home/me/.paws";
  expect(redactGitHubTokens(text)).toBe(text);
  expect(JSON.parse(redactedJson({ text })).text).toBe(text);
});
