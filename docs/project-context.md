# Project context

Paws keeps short, sourced context for each Linear project in its own Postgres database: the project description, its documents, and the decisions, constraints and open questions found in them. Linear stays the place where you edit project documentation. Paws never writes this context back to Linear. Each new agent session on an issue in the project receives a small, sourced selection of it in its brief.

## What Paws stores

Each record names its source (project description, project document or Paws task), the source's link and revision, who wrote it, when Paws read it, and one of five classifications: decision, verified fact, reported fact, inference or unresolved question. The source text itself is kept apart from what Paws derives from it. A correction by a person replaces the record with a new version and keeps its classification: an inference corrected by a person stays an inference.

Paws removes secrets such as tokens, private keys and credentials in URLs, and code blocks, before it stores anything. Records name people by their Linear user id only.

## Who sees it

Context belongs to one Paws workspace and one Linear project. Two projects or two workspaces never share records, even when names match. A person sees a record only while they can still read its source in Linear, and only when the destination is that project's audience. Paws leaves out records a person cannot read without saying they exist. When Paws can't confirm someone's access, it shows them nothing.

## Forgetting and expiry

| Event                                                       | What happens                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A person forgets a source                                   | Its records are cleared. Later revisions stay out until someone with access to the source re-adds it.                                                                                                                                  |
| A source is edited                                          | New text replaces old records; lines that left the source are cleared.                                                                                                                                                                 |
| A document is no longer among the ten most recently updated | Its records stay. On each read, Paws checks up to 20 such documents by id and keeps those still in the project. A document that hasn't been confirmed for an hour, or whose check failed, is left out until a later check confirms it. |
| A document is deleted, emptied or moved to another project  | Its records are cleared the next time Paws reads the project.                                                                                                                                                                          |
| A read of the project fails                                 | Paws leaves out the project's context until a later read succeeds. Nothing is cleared.                                                                                                                                                 |
| A source is deleted or revoked                              | Its records are cleared, and replaying the same or an older revision does not bring them back.                                                                                                                                         |
| A project is disconnected                                   | Every record in it is cleared, and Paws stores nothing new until it is reconnected.                                                                                                                                                    |

Retention defaults:

| Setting                       | Default                                          |
| ----------------------------- | ------------------------------------------------ |
| Record lifetime               | 180 days after Paws last read it                 |
| Old versions and cleared rows | Deleted 30 days after they stopped being current |
| Current records per workspace | 10,000                                           |
| Current records per project   | 2,000                                            |
| Records per source            | 40                                               |
| Source text per source        | 20,000 bytes                                     |

Over a cap, Paws clears the least important, oldest records first. Records removed by expiry or a cap come back the next time Paws reads their unchanged source. A short audit trail of who stored, corrected, forgot or re-added a source is kept without any record text.

## Selecting context for a prompt

Paws chooses a small, sourced selection from a project's context. It never sends the whole history. The selection is evidence, not an instruction, and it never approves an action.

Paws first sets aside room for the instructions, the current request, the tools and the response, then for recent working context. Memory gets what remains, up to its own budget. Paws counts with the model's tokenizer when it has one. Otherwise it estimates one token per two bytes of UTF-8 text plus four per piece of text. That estimate overcounts typical English text by about half, so a prompt stays within the cap. If the request alone does not fit, Paws returns no context instead of trimming the request.

Records a person can no longer read are never candidates. Half of the candidate reads go to corrections, open questions, decisions and inferences, so newer facts can't crowd them out. Records already covered by a summary in use are skipped. Records tied to a different repository or ref than the task are left out. Among the rest, Paws ranks corrections by people first, then unresolved questions, decisions and inferences, then reported facts, adjusted for relevance to the request, importance and age. Each kind keeps its own label, so an open question never reads as settled. Records that don't fit are listed by record id, and anyone who can still read a record can fetch it on its own.

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

## Rolling summaries

When summarizable facts would push memory past the soft threshold, Paws queues one compaction for that part of the project. A second request while one is pending is merged with it. Compaction folds new reported and verified facts into a rolling summary. Decisions, unresolved questions, inferences and corrections never go into a summary. Paws always keeps them as separate records, so a summary can't resolve them or change them.

A summary records which version of each record it covers, and only records whose text made it into the summary count as covered. The rest stay individual records until a later compaction. Before Paws calls the summarizer, before it saves the result and before it uses a summary, it checks that every covered record is still current and readable. Forgetting, deleting, revoking, expiring or evicting a source clears every summary built from it in the same database change. When a person corrects a record, Paws stops using the old summary until it builds a new one. A compaction that started earlier can't overwrite a newer summary. A crashed compaction gives up its claim after two minutes.

Compaction uses at most two slots in the Paws process. It does not use runner capacity. If the summarizer fails, times out or returns too much text, or the covered records change while it runs, Paws drops the request and doesn't compact that part of the project again until the retry interval has passed. It keeps the previous state and selects individual records and record ids within the budget. It never falls back to a stale summary. Compacting a session's transcript is separate: it changes nothing stored here.

## What a session receives

Before an agent's first turn on an issue in a Linear project, Paws reads the project's description and documents again (after a successful read, at most once every ten minutes per project; a failed or refused read is retried on the next turn), then selects context for the issue's request and the person's recent updates. The selection replaces `{{project_overview}}` in the brief, after the issue and its acceptance criteria. The issue's requirements win over anything remembered. A brief template that uses `{{project_overview}}` more than once gets the selection only the first time.

Paws puts a short index of the selection in the brief instead, and agents read the details of an entry with `recall`. The index is at most 1,000 tokens, including the closing notes. It starts with a line telling the agent to read an entry with `recall({id})` or search with `recall({query})`. Then each ranked record gets one line: its classification, the first 140 characters of its text, its source label and its id. Decisions come first, in full when shorter than 300 characters. Lines that don't fit are dropped from the end, and the first line says how many more entries `recall` can find. The session's stored manifest lists the records the index named.

Paws checks access as the person who delegated the issue, through their current Linear team membership. If Paws can't confirm it, or the person can no longer read the project, the brief says only that project context is not included. A project with nothing current to show gives no project context. With Linear connected, Paws never falls back to the raw project documents: they skip forgetting and access checks, so a forgotten document would come back. Without a connected Linear app, the brief keeps the old project overview, cut at 12,000 characters in total.

Every turn, including a restart or a resumed session, builds the selection again from what is current. A record that was forgotten, deleted, revoked or corrected since the last turn is gone from the next one. An old selection never grants access. Paws stores what each session received: a version number, the record ids and revisions, and the token accounting, without record text. When Paws sees that a stored selection went stale before it was delivered, it builds a new one, or sends none.

The selection ends with a note telling the agent that the context is background only. The agent should not copy it into Linear issues, comments or pull requests unless the task needs it. A remembered decision or approval never approves an action, a tool call, a run or a new issue. Starting work still goes through delegation and the normal runner placement.

## What agents may save

A work turn on an issue in a Linear project, including a follow-up conversation on it, gets the `remember` tool, and the project overview in its brief ends with a note that explains project memory. Answer, plan and artifact sessions, reviewers and Closeout checks don't get the tool or the note. Neither do items outside a project, or any item when Linear isn't connected.

An agent may save short facts and open questions that a later agent on the project should know: a convention, a constraint, a pitfall or a question nobody has answered. It should not save what's already in the code, the issue or the docs, task progress, or what it changed. It can't save decisions or approvals: Paws records those when a person answers a question.

| Limit                       | Value                                                      |
| --------------------------- | ---------------------------------------------------------- |
| Operations per call         | 1 to 5, applied together or not at all                     |
| Entry text                  | 400 characters, cleaned of secrets like every record       |
| Entries per issue           | 10. Patch or remove an entry this issue saved to make room |
| Entries an agent can change | Only those saved for the same issue                        |

Saved entries are records of the issue as a Paws task source, with the project's access restriction. They follow the same access checks, forgetting, expiry and caps as every other record.

## Decisions from people's answers

With decisions turned on in the saved `[project_memory]` settings (off by default), a person's answer to an agent's `ask_team` question on an issue in a Linear project is stored as a decision: the question, the answer, and who answered on which issue. This includes questions from answer, plan and artifact sessions. Question and answer are each cut to 300 characters. The person who answered is the record's actor, and their access to the project is checked when it's stored.

When the agent asks the same question again on the same issue, the new answer corrects that decision and keeps the earlier version in its history. A different question gets its own decision, even when it starts with the same words. Paws's own questions, like repository, runner or time-limit questions, and answers Paws rejects record nothing.

Recording is best effort. If the person's access can't be checked, they can't read the project, or storing fails, Paws writes one journal line and stores nothing. The answer still reaches the agent and the task carries on. Paws doesn't retry later, and if it stops between saving the answer and storing the decision, that decision is not stored.

On the project's context page, entries an agent saved are labelled "Agent on" the issue, and answered decisions "Work item memory on" the issue. Each keeps its own label when the other kind is saved for the same issue later.

Preparing a selection, compacting it, inspecting what a session received, and correcting or forgetting a record all run inside the Paws process. They need no runner and work while every runner is busy.

## Using project context from another consumer

A later consumer, such as Slack conversations, uses the same store, selection and compaction with its own scope. It passes:

| Input                   | Meaning                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Scope                   | Workspace and scope kind and id: a Linear project, a Slack channel or one person's private messages            |
| Principal               | The person the context is selected for. Paws checks their current access on every call                         |
| Audience                | Who will read the output. It must match the scope: project members, channel members, or the one person in a DM |
| Repository and ref      | Optional. Records tied to another repository or ref are left out                                               |
| Budget                  | The model's context window, output limit and token counter, and the budget settings above                      |
| Request and recent work | The current request, instructions and tool size, and recent conversation turns with their times                |
| Consumer key            | A stable id for the conversation or work item. Paws stores one manifest version per key                        |

It gets back the selection text, recent context, and a manifest: the scope generation, the records and summary used, counts and tokens. Before it delivers output built from a selection, including a queued or retried message, it asks Paws whether that manifest version is still current for the same principal and audience. A stale answer means rebuild or send nothing.

Inspection of a stored session shows only records the inspecting person can read now, with no count of the rest. Corrections and forgetting use the same access checks as above.

Scopes stay apart. A channel or a private DM never sees project records, and a project never sees channel or DM records. The consumer keeps its own identity checks, conversation mapping, streaming and output checks, and source access. Paws does not post to Slack, write to Linear, create issues or start work from this context.
