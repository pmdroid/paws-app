# Review checks and evidence

Closeout checks an agent's work before Paws publishes or merges its pull request. Each repository chooses its checks in `.agents/closeout.yaml` or a [local Closeout policy](local-closeout.md). CI, reviews and GitHub branch protection also determine when a pull request can merge.

## Follow verification

Open the issue in the dashboard to see the current run, check results, review findings and evidence. Command checks run the repository's configured commands. Independent reviews inspect the proposed change. Evidence checks require the files requested by the policy.

When a check fails, Paws can send the findings back to the agent for another attempt. Retry budgets come from the [configuration](configuration.md#closeout-retry) and the repository policy. If Paws needs a decision, it asks in Linear and on the question page.

## Review evidence

Open each evidence file and compare it with the requested change. A visual review may ask you to accept the result or request changes. Explain what needs to change when rejecting it. Review the latest files: replacements need a fresh review.

An approval applies to the evidence and candidate you reviewed. Changed evidence may require another approval.

## Resolve a verification question

Read the failed check and its output before choosing an action. You can give the agent guidance, retry verification when the problem is resolved, or use the dashboard's available controls. If you bypass a check, supply the reason requested by Paws.

## Follow merging

After verification accepts the candidate, the pull request enters the merge queue. Paws waits for required CI and reviews. If the target branch moves or a reviewer requests changes, Paws follows your [merge settings](configuration.md#merge) and may ask the agent to fix or recheck the work.

Keep work left for later in tracker issues so it can be delegated and reviewed separately.
