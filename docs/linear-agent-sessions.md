# Follow work in Linear

Delegate an issue to the Paws app after [setting up your workspace](workspace-access.md). Use [repository selection](repository-selection.md) to choose where it runs.

Each issue has its own agent session. A parent issue's sub-issues run in dependency order, with a session for each one. Follow the session for progress, questions, results and the pull request link. The dashboard's issue page shows the work history and current run.

## Answer a question

When Paws needs your decision, it asks in the session. Reply there or open the question in the dashboard. Include the guidance the agent needs to continue. Questions about repository access or verification may need an administrator or the person who delegated the issue.

After opening a pull request, Paws uses the session for questions and its final result. Follow the pull request and dashboard for checks and merge progress.

## Stop work

Use Stop in Paws or stop the agent session in Linear. Stopping ends that work; it does not approve or merge its pull request. Check the dashboard before delegating the issue again.

## When work is waiting

Check the issue page for the reason. It may need a dependency to finish, a runner with repository access, an answer, or passing verification. For verification questions, see [Review checks and evidence](closeout.md). For access, see [Workspace access](workspace-access.md) and [GitHub App setup](github-app.md).
