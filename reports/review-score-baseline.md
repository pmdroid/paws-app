# Reviewer score: independent-review

Generated 2026-10-27T03:54:44.310Z by `bun scripts/review-score.ts`. See [Reviewer score](../docs/closeout.md#reviewer-score).

| Setting                  | Value                                                         |
| ------------------------ | ------------------------------------------------------------- |
| Skill                    | `.agents/skills/review-paws/SKILL.md` (sha256 `3fb91d9be4d2`) |
| Model                    | `gpt-6.1-sol`, effort `medium`                                |
| Scope                    | `diff`                                                        |
| failOn                   | `P1`                                                          |
| Caught when              | a finding at or above `P1` is within 5 lines of the bug       |
| Clean pull requests      | quiet for 7 days after the merge                              |
| Price per million tokens | not set (pass --price)                                        |

## Summary

| Measure                                       | Value                                   |
| --------------------------------------------- | --------------------------------------- |
| Recall, confirmed escapes                     | 0 of 14 (0%)                            |
| Recall, likely escapes                        | 0 of 2 (0%)                             |
| Escapes rejected, but not at the bug          | 4                                       |
| Escapes found at the bug below failOn         | 1                                       |
| False positives, clean pull requests rejected | 0 of 4 (0%)                             |
| Reviews that recorded no findings (left out)  | 0                                       |
| Time per review                               | median 36 s, mean 39 s                  |
| Tokens, all 20 reviews                        | 838,353 in (420,864 cached), 36,131 out |
| Cost                                          | not priced                              |

## Escapes

| Case      | Confidence | Diff      | Outcome            | Near the bug | Time | Tokens  | Blocking findings                       |
| --------- | ---------- | --------- | ------------------ | ------------ | ---- | ------- | --------------------------------------- |
| 579-655   | confirmed  | squash    | missed             | –            | 28 s | 30,507  | –                                       |
| 673-678   | confirmed  | squash    | missed             | –            | 28 s | 32,609  | –                                       |
| 707-791   | confirmed  | candidate | missed             | –            | 11 s | 23,492  | –                                       |
| 709-779   | confirmed  | candidate | rejected elsewhere | P2           | 83 s | 47,709  | P1 `src/web/src/client/skills.ts:43`    |
| 724-781   | confirmed  | candidate | missed             | –            | 33 s | 62,536  | –                                       |
| 735-877   | confirmed  | squash    | rejected elsewhere | –            | 68 s | 35,786  | P1 `src/runner-execution/skills.ts:174` |
| 927-929   | confirmed  | squash    | missed             | –            | 63 s | 62,962  | –                                       |
| 941-955   | confirmed  | squash    | missed             | –            | 26 s | 34,226  | –                                       |
| 973-983   | confirmed  | squash    | missed             | –            | 19 s | 25,605  | –                                       |
| 978-982   | confirmed  | squash    | missed             | –            | 16 s | 29,604  | –                                       |
| 985-989   | confirmed  | squash    | rejected elsewhere | –            | 75 s | 144,076 | P1 `src/loop/orchestrator.ts:1674`      |
| 990-994   | confirmed  | squash    | missed             | –            | 54 s | 71,540  | –                                       |
| 732-834   | confirmed  | candidate | missed             | –            | 25 s | 28,078  | –                                       |
| 1006-1015 | confirmed  | squash    | rejected elsewhere | –            | 40 s | 83,150  | P1 `src/runner-backend/index.ts:843`    |
| 783-974   | likely     | candidate | missed             | –            | 50 s | 29,555  | –                                       |
| 715-851   | likely     | squash    | missed             | –            | 38 s | 26,822  | –                                       |

## Clean pull requests

| Case      | Quiet days | Diff   | Outcome | Time | Tokens | Blocking findings |
| --------- | ---------- | ------ | ------- | ---- | ------ | ----------------- |
| clean-544 | 7          | squash | passed  | 16 s | 20,412 | –                 |
| clean-549 | 7          | squash | passed  | 39 s | 27,723 | –                 |
| clean-552 | 7          | squash | passed  | 36 s | 21,665 | –                 |
| clean-560 | 7          | squash | passed  | 37 s | 36,427 | –                 |

## Findings

### 709-779 (rejected elsewhere)

- **P1** `src/web/src/client/skills.ts:43`: Missing runner integration: the UI says registered skills are installed before every run, but the change only stores bundles and database pins and exposes settings operations. No execution or runner path receives those pins or bundles. Adding, updating, re-scoping, or removing a skill therefore does not change what agents load. The removal notices in src/settings/skills.ts and src/web/src/client/skills.ts also promise an uninstall that is not implemented.

### 735-877 (rejected elsewhere)

- **P1** `src/runner-execution/skills.ts:174`: Symlink traversal: removeFolder renames and recursively deletes a target without checking its parent directories. The agent owns the home’s skill directories and can replace .claude/skills, .codex/skills, or .grok/skills with a symlink to another directory. When Paws removes a previously installed skill or removes an agent from its configuration, the privileged daemon can then delete a directory outside the agent home.

### 985-989 (rejected elsewhere)

- **P1** `src/loop/orchestrator.ts:1674`: Missing execution authorization check: removing admission.canStart from the execution path allows a queued task to launch after execution permission is revoked. A scheduler reservation can already exist when permission changes, and the new claim gate checks only the reservation, item state, cancellation flag, and live runs. Revalidate execution permission before launching the task so an existing reservation cannot bypass a subsequent restriction.

### 1006-1015 (rejected elsewhere)

- **P1** `src/runner-backend/index.ts:843`: Incorrect conditional precedence prevents restoration on a capable target runner. The restore session ID is selected only when the existing session-resume condition is false. When that condition is true, earlierSession instead searches the target runner, which may have no prior session for this run. The command then includes restoreSession with an undefined or different resumeSessionId, violating the newly added RunnerCommandSchema refinement and preventing dispatch. Prefer the eligible restore session ID before consulting earlierSession.
