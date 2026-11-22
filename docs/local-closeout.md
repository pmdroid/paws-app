# Local Closeout policy

Keep the Closeout policy for a work repository on your machine. [Review checks and evidence](closeout.md) explains verification. Save the repository's policy folder in Settings > Closeout. See [Closeout settings](configuration.md#closeout).

The project key is the GitHub `owner/repo`, matched without case sensitivity. `policyRoot` is an absolute directory on the Paws host. A save applies without restarting Paws.

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

The entry policy can say what a restart runs again with an optional `rerun` key. An imported file that contains `rerun` does not load.

```yaml
rerun:
  conflict:
    run: [lint, typecheck, test]
    reviews: false
  ci:
    run: failed
```

`rerun.conflict.run` lists the command checks to run after a conflict fix. Each id must name a `kind: command` check in the policy, and an imported check uses its prefixed id, such as `team/test`. `rerun.conflict.reviews` defaults to `true`. `rerun.ci.run` is `all` (the default) or `failed`. Any other key under `rerun` makes the policy invalid.

After a restart that only resolves a merge conflict, the fixed commit runs only the `rerun.conflict.run` checks, and the other command checks that passed on the accepted commit are carried from it. With `reviews: false`, the reviews that passed there are carried too. Carried checks show "carried from <commit>: passed there, not run again after the conflict fix". This applies only when the accepted, not high-risk pull request came back from the merge queue to rebase with nothing else to fix, **When main moved before the merge** is not Closeout, main's policy is the one the accepted commit was verified with, every listed id ran on the accepted commit, CI is green on the fixed commit, the checks the turn ran there used the same policy, and the fix changes no file the accepted commit did not. Otherwise every check and review runs. GitHub CI must still pass on the fixed commit before the merge.

A command check can also have `since`, the command to run when the check only has to cover changes made after an earlier commit. It is an argv like `exec` and needs exactly one element that is `{since}`, for example `since: ["bun", "scripts/affected-tests.ts", "{since}"]`. Only command checks accept `since`.

Runners need a release that knows these keys. An older runner skips them and warns about unknown policy keys.
