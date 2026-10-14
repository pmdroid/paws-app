# Local Closeout policy

Keep the Closeout policy for a work repository on your machine. Add this to `~/.paws/config.toml` before running `paws setup`:

```toml
[closeout.projects."acme/widgets"]
policy_root = "projects/widgets"
```

The project key is the GitHub `owner/repo`, matched without case sensitivity. `policy_root` is an absolute directory or a path relative to `PAWS_HOME`, which defaults to `~/.paws`. Use one section per repository.

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

The policy digest includes imported policies and every referenced skill file. Changing any of those files requires fresh evidence. Review prompts use the skill bytes captured with that digest, including text resources and hashes for binary resources. Decisions show the local policy path and a `local-policy` warning.

Paired runners use the same selected policy. Paws sends its commands for execution in the runner’s candidate checkout and sends the captured review prompt through the signed runner request. The policy and skills stay outside the repository.
