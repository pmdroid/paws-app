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
