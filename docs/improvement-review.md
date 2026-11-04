# Improvement review API

The improvement inbox lists daily findings and weekly retro proposals together. Each improvement carries one review decision, tied to one immutable proposal version. `src/improvements` serves the shared review routes; `src/retros/http.ts` serves the retro history, report, evidence and download routes.

Every route checks active workspace membership on each request before it reads anything. The reader's Linear sessions (see [Dashboard API](dashboard-api.md#authorization)) decide what is visible. A daily item needs every member finding in a readable session. A retro item needs all of its saved evidence in readable sessions and workspace repositories. An item outside that set answers the same 404 as an unknown id. Lists, counts and repository filters are built only from visible items. Responses are `no-store`. A mutation passes the server's origin and CSRF checks and is audited.

## Inbox

| Route                                               | Does                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/improvements`                             | Visible items, filtered by `source` (`daily`, `weekly`), `repository` and `state` (`needs_review`, `pending`, `linked`, `rejected`), with `cursor` and `limit` (at most 100). Returns `counts` over all visible items.                     |
| `GET /api/improvements/<id>`                        | The item with its proposal history, decisions, criterion annotations and saved evidence. Also the Linear teams this reviewer may file to (`destinations`) and up to ten known issues already linked in the same repository (`candidates`). |
| `POST /api/improvements/<id>/decision`              | `{ expectedVersion, decision }`: accept, reject with a reason, or reopen.                                                                                                                                                                  |
| `POST /api/improvements/<id>/deliveries/<id>/retry` | Puts a failed delivery back in the queue under the same id.                                                                                                                                                                                |

An accept names `proposalVersion` (the latest one) and exactly one intent:

- `{ kind: "create", teamId }`: the team must be mapped to the item's repository, and a member must belong to it. If the item already has an issue, this answers 409 `known_issue`: link that issue instead.
- `{ kind: "link", issue, addEvidenceComment?, allowClosed? }`: Paws reads the issue from Linear first. A missing issue answers 400. An issue in a team outside the repository's mapping answers 409 `team_mismatch`. A closed issue answers 409 `issue_closed` unless `allowClosed` is set, and linking never reopens it. If Linear is unavailable, nothing is saved and the route answers 503. Only `addEvidenceComment: true` queues an evidence comment; a plain link posts nothing.

An accept writes the actor, time, chosen intent, destination and exact proposal text to the delivery, all in one transaction. If no criterion was ever recorded, the reviewer must send `verificationCriterion`. A daily finding has none until then. The criterion becomes a versioned annotation and the source proposal is left as it was. A reject records its reason and creates no delivery. Issue creation itself is done by the outbox handler that claims these deliveries.

### Conflicts and retries

- Sending the decision already recorded again answers 200 with `status: "unchanged"`. That covers duplicate clicks and repeated requests.
- A different decision with an old `expectedVersion` answers 409 `stale` and returns the current decision. It never overwrites another reviewer.
- An accepted item cannot be rejected or reopened (409 `accepted`): its delivery may already have reached Linear.
- If a Findings action already claimed, filed or added any of an item's findings, the inbox accept answers 409 `legacy`. The other way round, a Findings File or Add on findings the inbox accepted answers 409.
- A delivery reports `pending`, `retryable` (failed), `unknown` or `succeeded`. Only a succeeded delivery has a canonical issue. Retrying a failed delivery keeps the item accepted. An `unknown` delivery answers 409 `reconciling`: the handler checks the same operation before writing again.

## Retros

| Route                                                       | Does                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/retros/history`                                   | Retros with at least one visible item or full access, with `cursor` and `limit` (at most 50).                                                                  |
| `GET /api/retros/reports/<id>`                              | The frozen report. With partial access, it has visible items only and no numbers, prior work, other repositories' windows, coverage gaps or generation errors. |
| `GET /api/retros/reports/<id>/items/<item>/evidence`        | The item's excerpts from the saved evidence. Mutable session history is never queried.                                                                         |
| `GET /api/retros/reports/<id>/digest`, `/report`, `/prompt` | Download the frozen digest, the rendered report or the rendered prompt.                                                                                        |

The rendered prompt embeds the full digest. So all three downloads need full access: every included repository and every session in the digest. Partial access answers 403 `partial_access`, without naming what is missing. Each download is audited.
