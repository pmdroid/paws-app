# paws-demo

Bun and TypeScript repository used to smoke-test Paws. It is not a library. Delegating the Linear parent **Export rows** should merge three pull requests in order, answer one question in Linear, and run one Closeout fix loop, without manual git.

| Issue                  | What it proves                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Fix `exportRows`       | Seeded failing test. Closeout rejects a pull request that does not make `src/export.test.ts` pass.  |
| Add `exportWithHeader` | Blocked by the export fix and edits `src/export.ts`.                                                |
| Archived rows          | Calls `ask_team` with `Include archived rows?` and options `yes` and `no`, then applies the answer. |

The epic seed is `epic/epic.json` (prose in `epic/EPIC.md`). Acceptance commands are in `.agents/closeout.yaml`.

`bun test` in this repository fails until `exportRows` is fixed. That failure is the fix loop.

## Push this template to GitHub

From this directory, with `gh` already logged in:

```sh
./scripts/push-template.sh --yes
```

That creates `pmdroid/paws-demo` when it is missing and force-pushes `main`. Override the destination with `PAWS_DEMO_REPO=owner/paws-demo`. The repository name must be `paws-demo`.

## Reset Linear and GitHub

From a checkout of the Paws repository (the script is not copied into this repo):

```sh
LINEAR_API_KEY=lin_api_... bun scripts/demo-reset.ts --yes
```

`LINEAR_ACCESS_TOKEN` is accepted when `LINEAR_API_KEY` is unset. Optional: `PAWS_DEMO_TEAM` (Linear team key, default `ENG`) and `PAWS_DEMO_REPO`.

The reset is safe to re-run. It restores issue titles, descriptions, the `paws` label, and an unstarted state (Todo when the team has one), deletes issue comments, recreates the `blocks` edges, deletes remote `paws/` branches, closes open pull requests from those branches, and force-pushes this template to `main`.
