# Project context

Each agent session on a Linear issue receives the issue's Linear project overview and the shared notebooks in its brief ([what a session receives](#what-a-session-receives)). Agents on code tasks can edit those notebooks ([what agents may save](#what-agents-may-save)). Separately, [Slack channel memory](slack.md#channel-memory) keeps short, sourced records in Paws's own Postgres database ([Slack channel memory](#slack-channel-memory)). Paws never writes any of this back to Linear.

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

Without `operations` the tool returns the notebook and its size. With 1 to 8 operations (`add`, `patch` or `remove`, each entry at most 1,000 characters) it applies all of them or none: when the result would be over the limit, nothing is written and the agent gets the reason and the current notebook. An add that is already there is ignored. An agent may patch or remove any entry, including one another agent wrote. Each change records the issue and the person who delegated it, and people can inspect and undo changes.

## Slack channel memory

[Channel memory](slack.md#channel-memory) belongs to one Paws workspace, one Slack installation and one channel. Two channels or two workspaces never share records, and channel memory never reaches a Linear work session. A member's answers use the memory only while they are a linked, active member of the channel's current setup; when Paws can't confirm that, it uses nothing. Preparing memory for an answer, compacting it, and correcting or forgetting a record all run inside the Paws process. They need no runner and work while every runner is busy.

### What Paws stores

Each record names its source, the source's link and revision, who wrote it, when Paws read it, and one of five classifications: decision, verified fact, reported fact, inference or unresolved question. The source text itself is kept apart from what Paws derives from it. A correction by a person replaces the record with a new version and keeps its classification: an inference corrected by a person stays an inference.

Paws removes secrets such as tokens, private keys and credentials in URLs, and code blocks, before it stores anything. Records name people by their user id only.

### Forgetting and expiry

A person who forgets an entry clears it and every summary built from it, and a later replay of the same message doesn't bring it back. A correction replaces the entry with a new version and keeps the old text only as history.

Retention defaults:

| Setting                       | Default                                          |
| ----------------------------- | ------------------------------------------------ |
| Record lifetime               | 180 days after Paws last read it                 |
| Old versions and cleared rows | Deleted 30 days after they stopped being current |
| Current records per workspace | 10,000                                           |
| Current records per channel   | 2,000                                            |
| Records per source            | 40                                               |
| Source text per source        | 20,000 bytes                                     |

Over a cap, Paws clears the least important, oldest records first. A short audit trail of who stored, corrected or forgot an entry is kept without any record text.

### Selecting memory for an answer

Paws chooses a small, sourced selection from a channel's memory. It never sends the whole history. The selection is evidence, not an instruction, and it never approves an action.

Paws first sets aside room for the instructions, the current request, the tools and the response, then for recent working context. Memory gets what remains, up to its own budget. Paws counts with the model's tokenizer when it has one. Otherwise it estimates one token per two bytes of UTF-8 text plus four per piece of text. That estimate overcounts typical English text by about half, so a prompt stays within the cap. If the request alone does not fit, Paws returns no context instead of trimming the request.

Records a person can no longer read are never candidates. Half of the candidate reads go to corrections, open questions, decisions and inferences, so newer facts can't crowd them out. Records already covered by a summary in use are skipped. Among the rest, Paws ranks corrections by people first, then unresolved questions, decisions and inferences, then reported facts, adjusted for relevance to the request, importance and age. Each kind keeps its own label, so an open question never reads as settled. Records that don't fit are listed by record id, and anyone who can still read a record can fetch it on its own.

Each selection comes with a manifest. It lists the scope and audience version, the records used with their source and revision, counts of selected and left-out records, the token accounting and the summary used. It never mentions records the reader can't see.

| Setting                   | Default | Rule                                                   |
| ------------------------- | ------- | ------------------------------------------------------ |
| Hard prompt cap           | 200,000 | Lowered to the model's context window when smaller     |
| Response reserve          | 8,000   | Raised to the model's output limit when larger         |
| Memory                    | 6,000   | Memory, recent context and response stay below the cap |
| Recent working context    | 4,000   | Newest first, at most 20 entries                       |
| Compaction soft threshold | 4,500   | Below the memory budget                                |
| Candidates read           | 200     | At most 200                                            |
| Omitted records listed    | 20      | At most 50                                             |
| Summarizer input          | 12,000  |                                                        |
| Summary size              | 1,500   | Below the soft threshold                               |
| Summarizer timeout        | 60 s    | 1 s to 5 min                                           |
| Retry after a failure     | 10 min  | 1 min to 1 day                                         |

Token values are tokens. Paws rejects a setting outside its range or one that breaks a rule.

### Rolling summaries

When summarizable facts would push memory past the soft threshold, Paws queues one compaction for that part of the channel. A second request while one is pending is merged with it. Compaction folds new reported and verified facts into a rolling summary. Decisions, unresolved questions, inferences and corrections never go into a summary. Paws always keeps them as separate records, so a summary can't resolve them or change them.

A summary records which version of each record it covers, and only records whose text made it into the summary count as covered. The rest stay individual records until a later compaction. Before Paws calls the summarizer, before it saves the result and before it uses a summary, it checks that every covered record is still current and readable. Forgetting, expiring or evicting an entry clears every summary built from it in the same database change. When a person corrects a record, Paws stops using the old summary until it builds a new one. A compaction that started earlier can't overwrite a newer summary. A crashed compaction gives up its claim after two minutes.

Compaction uses at most two slots in the Paws process. It does not use runner capacity. If the summarizer fails, times out or returns too much text, or the covered records change while it runs, Paws drops the request and doesn't compact that part of the channel again until the retry interval has passed. It keeps the previous state and selects individual records and record ids within the budget. It never falls back to a stale summary. Compacting a session's transcript is separate: it changes nothing stored here.
