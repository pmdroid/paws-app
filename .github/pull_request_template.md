> Keep the PR small and focused. Explain why it matters, what changes, the important choice, the evidence, and how hard a merge is to undo. Write in increasing detail for a customer or PM, a new engineer, then a specialist. Three to five sentences per section is a ceiling; one is fine. The author must explain and defend every line, including AI-assisted work.

Closes

> Link the issue this PR completes. For GitHub, use `Closes #123` in the same repository or `Closes owner/repo#123` across repositories. For Linear, write the bare issue ID after `Closes`, such as `Closes PAS-123`. For partial work, use `Refs` with the GitHub issue or `Part of` with the Linear ID. File an issue first if none exists. Do not use brackets or placeholder text for Linear IDs, or write "Linear issue:" or "Linear ticket:". Keep the ID out of the PR title, which uses `type(scope): summary` with `feat`, `fix`, or `chore`.

## What/why

> Explain the problem and the observable behavior that changes, with enough context to understand without opening the issue. Where useful, explain how to reproduce the old behavior and recognize the new one.

## Codebase changes

> Open with the smallest sketch that explains the approach, such as pseudocode, a call tree, a component tree, a shallow file tree, or a Mermaid diagram. Explain consequential decisions that are not obvious from the diff. A change too small to sketch needs one sentence. Skip file inventories and coding diaries.

## Proof

> Prove the promised behavior on the current head. Use the repository's [verify-paws skill](https://github.com/pmdroid/paws-app/blob/main/.agents/skills/verify-paws/SKILL.md) for runnable Paws behavior. State the claim before testing and keep baseline and treatment evidence for fixes. Report `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`, with passing, failing, and skipped checks named separately.
>
> Run `bun --no-env-file scripts/verify-local.ts check` for the suite and behavioral audit, or `bun --no-env-file scripts/verify-local.ts audit` for the audit alone. The fixture uses real SQLite, Git worktrees, ACP transport, native Closeout, local squash merges, and production status handlers. Linear intake uses a fake tracker and comment board with a directly injected created event. The production GitHub pull-request adapter calls an in-memory API fake. Coding agents and independent-review text are scripted. Name which boundaries were real, scripted, stubbed, or only judged. A fixture pass does not prove real login, hosted-service compatibility, or model judgment.
>
> For dashboard changes, run `bun --no-env-file scripts/verify-local.ts serve` and drive the printed disposable `/status` URL on desktop and a narrow mobile viewport. Capture the same flow before and after the change, record browser errors, and upload screenshots or a recording to the PR. Fill the Before/After table with hosted media links. Keep the task ID, stop only that disposable server, and confirm its port closes. Follow the skill's credential isolation rules; never use the operator's live instance for mutation tests.
>
> Use one verification row per promised behavior or state. Name the command or skill, assertion, observed result, and source commit. For backend-only changes, remove the Before/After table. When nothing is runnable, remove both tables and explain what was judged and against what evidence. Fill the verification field with the observed verdict or documentation judgment before removing this guidance.

**Verification:**

| Behavior | How it was proven |
| -------- | ----------------- |
|          |                   |

| Before | After |
| ------ | ----- |
|        |       |

## Merge danger

> Door: two-way when reverting the PR fully undoes it. One-way when it migrates or deletes data, changes a published contract, or reaches customer installs a revert cannot recall. Explain why in a sentence; a one-way door names its rollback or mitigation.
>
> Blast radius: start with `none`, `local`, `service`, `platform`, or `customers`, then say what breaks and for whom if the change is wrong. Explain controls for sensitive changes and any rollout constraints, including deploy order, compatibility windows, or flags.

**Door:**

**Blast radius:**

## Additional notes

> Include a specific reviewer decision when needed. Track deferred work and known limitations in issues.
