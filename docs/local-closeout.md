# Local Closeout policy

Keep the Closeout policy for a work repository on your machine. [Review checks and evidence](closeout.md) explains verification. Save the repository's policy folder in Settings > Closeout. See [Local Closeout policy roots](configuration.md#local-closeout-policy-roots).

The project key is the GitHub `owner/repo`, matched without case sensitivity. `policyRoot` is an absolute directory on the Paws host. A save applies without restarting Paws. Before the first save, Paws reads `[closeout.projects."owner/repo"] policy_root` from `~/.paws/config.toml`, where a path relative to `PAWS_HOME` also works.

Create this directory layout:

```text
~/.paws/projects/widgets/
  .agents/
    closeout.yaml
    checks.yaml
    skills/
      review/
        SKILL.md
        references/
          rules.md
```

For example, `.agents/closeout.yaml` can contain:

```yaml
specVersion: "0.1"
imports:
  - as: team
    path: .agents/checks.yaml
items:
  - id: review
    kind: review
    gate: beforePR
    skill: .agents/skills/review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
```

Put repository checks in `.agents/checks.yaml`:

```yaml
specVersion: "0.1"
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test"]
    timeoutSeconds: 120
```

Write the review instructions in `SKILL.md` and supporting text in `references/rules.md`. Import and skill paths resolve from `policy_root`. Commands run against the candidate checkout.

The local policy replaces the repository policy for that project. Paws blocks verification if the configured local policy is missing or invalid. Setup preserves this setting and validates the local policy without creating `.agents/closeout.yaml` in the work repository. Run `bun run paws doctor` to check the selected policy.

Changing the policy or its review instructions requires fresh verification. Review results identify the selected local policy. Paired runners use the same policy, with commands executed against the candidate checkout.

Checks, rules and setup steps can use `paths` to limit which changed files trigger them. The optional `except` list requires `paths` and excludes matching files from that scope. Both lists use repository-relative patterns: `*` and `?` match within a segment, `**` matches across segments, and a trailing `/` matches a prefix. For example, `paths: ["src/dashboard/**"]` with `except: ["**/*.test.ts"]` requires visual proof for dashboard source changes but skips test-only changes.
