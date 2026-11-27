# Rulecheck shadow comparison

Rulecheck's `Rulecheck shadow` workflow uploads a `rulecheck-evidence` receipt for each pull request head. Paws can produce the same receipt from a Closeout command and compare the two. The comparison is shadow only: Closeout's own checks still decide, and nothing here blocks, accepts or merges a pull request.

## Produce the Paws receipt

Add a command item and a setup step to the repository's `.agents/closeout.yaml`. The wrapper always exits 0 so the item can't fail Closeout, and records Rulecheck's real exit code on stderr for the comparison:

```yaml
setup:
  - id: rulecheck-tools
    exec: ["sh", "-c", "npm ci --ignore-scripts --no-audit && cargo build --locked --release"]
    timeoutSeconds: 900
items:
  - id: rulecheck
    kind: command
    gate: beforePR
    exec:
      - sh
      - -c
      - >-
        node tools/check-ci.mjs "$(git rev-parse --path-format=absolute --git-common-dir)"
        "$(git rev-parse origin/main)" "$(git rev-parse HEAD)" target/release/rulecheck;
        echo "rulecheck-exit=$?" >&2; exit 0
    timeoutSeconds: 600
```

Leave `ci:` off this item. With `ci:` set, Closeout can take the result from green CI instead of running Rulecheck, and the comparison then refuses it because the Paws result would not be independent.

## Compare a head

Download the CI receipt for the head and compare it with the Closeout record Paws stored for the same head:

```sh
gh run download <run-id> --repo <owner>/<repo> --name rulecheck-evidence --dir ci-receipt
bun scripts/rulecheck-shadow.ts --head <sha> --ci ci-receipt/rulecheck-evidence.json \
  --evidence ~/.paws/closeout/evidence/<item> [--item rulecheck]
```

`--evidence` is the item's folder under `~/.paws/closeout/evidence`. Pass `--paws <file>` instead to compare a receipt file. Add `--json` for the full comparison as JSON.

The report compares the candidate and base SHAs, each phase's policy commit, policy digest and outcome, the builder and evaluator versions, the required phases, and the pass, violation or cannot-judge outcome. Different Node.js or Git versions, and the policy owner's review that only CI reads, are listed as notes. Each failed phase is labelled as a code finding, failing fixtures, a policy configuration problem, an evaluator error or a missing owner approval, with what to do about it. The exit code is 0 when CI and Paws agree, 1 when they disagree and 2 when they can't be compared yet.

A receipt counts only for the head it names. After a push, both receipts are stale until CI and Closeout run on the new head. A merge-group head is a different commit from the pull request head, so pass `--merge-group --pull-head <sha>`: the pull request's CI receipt doesn't count for it, and the merge group needs a CI result of its own. The Rulecheck workflow runs only for pull requests, so a merge group has no CI receipt yet.

The base SHA can differ when `main` moved between the CI run and the Closeout run. Rerun the one that ran first before comparing again.

## Rollout criteria

Keep Rulecheck advisory until all of these hold:

- The repair and recurrence pilot is verified: one real finding fixed with its guard, and a later pull request that repeats it fails on the exact candidate in CI and in Paws.
- Comparisons on consecutive pull request heads agree, including at least one violation, one failing fixture and one cannot-judge result, with no unexplained difference.
- Every stale-head and merge-group comparison reports the evidence as missing instead of agreeing.
- The repository enforces code-owner approval for `.rulecheck/` and `.github/`, and the shadow workflow runs from the trusted base branch.
- Merge groups get their own Rulecheck CI run.

Meeting these criteria doesn't turn anything on. Making Rulecheck required is a separate change to branch protection and the Closeout policy, made and reviewed by a person.

## Switch back

The comparison changes nothing in Paws, so switching back is removing what was added:

1. If Rulecheck was made a required check, remove it from the branch protection rules or ruleset first, so open pull requests don't wait on it.
2. Delete the `rulecheck` item and the `rulecheck-tools` setup step from `.agents/closeout.yaml`. Closeout keeps its other checks unchanged.
3. Leave stored Closeout records and CI artifacts in place. Closeout ignores records for items its policy no longer lists.
