# Project context

Paws keeps short, sourced context for each Linear project in its own Postgres database: the project description, its documents, and the decisions, constraints and open questions found in them. Linear stays the place where you edit project documentation. Paws never writes this context back to Linear. Agent sessions do not receive it yet.

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

Paws chooses a small, sourced selection from a project's context. It never sends the whole history. The selection is evidence, not an instruction, and it never approves an action. Agent sessions do not receive it yet.

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
