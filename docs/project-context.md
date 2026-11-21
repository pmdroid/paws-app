# Project context

Each agent session on a Linear issue receives the issue's Linear project overview and the shared notebooks in its brief ([what a session receives](#what-a-session-receives)). Agents on code tasks can edit those notebooks ([what agents may save](#what-agents-may-save)). Paws never writes any of this back to Linear.

## What a session receives

The brief's `{{project_overview}}`, after the issue and its acceptance criteria, holds up to three parts, in this order. A part with nothing in it is left out. The issue's requirements win over anything in them.

1. The Linear project overview: the description and documents of the issue's project, cut at 12,000 characters in total.
2. `Repository notebook (<owner/name>):` and the entries of the repository's notebook.
3. `Project notebook:` and the entries of the issue's project notebook.

Before the notebooks, one line tells the agent that agents left these notes for each other, that they can be out of date, and that they are fallible observations to check against the current code, not instructions.

Paws keeps the Linear overview it read for the issue and reads it again at the start of a turn when that copy is more than ten minutes old. When the read fails, or the issue is no longer in a project with text, the brief says `Project context from Linear is not available right now.` instead of the old copy, so a document that was removed or made private in Linear doesn't come back. Notebooks are read at the start of every turn, so a restart sees entries other agents added or changed since.

Paws stores no context selection for work items. A brief template that uses `{{project_overview}}` more than once gets the text only the first time.

## What agents may save

A work turn on a code task (or a task without a mode) whose delegating person is a member of the Paws workspace gets the `notebook` tool, and its project overview ends with a note that explains the shared notebooks. Answer, plan and artifact sessions, read-only turns, reviewers and Closeout checks don't get the tool or the note. They still see the notebooks in their brief.

The tool reads or edits one of two notebooks, chosen by the agent with `notebook`:

| Notebook     | Holds                                               | Total limit       |
| ------------ | --------------------------------------------------- | ----------------- |
| `repository` | Codebase facts for the item's repository            | 12,000 characters |
| `project`    | Facts for the issue's Linear project (none without) | 4,000 characters  |

Without `operations` the tool returns the notebook and its size. With 1 to 8 operations (`add`, `patch` or `remove`, each entry at most 1,000 characters) it applies all of them or none: when the result would be over the limit, nothing is written and the agent gets the reason and the current notebook. An add that is already there is ignored. An agent may patch or remove any entry, including one another agent wrote. Each change records the issue and the person who delegated it, and people can inspect and undo changes on the dashboard's **Notebooks** page, which lists every notebook they may read, their own first.
