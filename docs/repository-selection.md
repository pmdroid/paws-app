# Repository selection

Paws works in one GitHub repository per Linear issue. It picks the repository in this order and stops at the first match:

1. `[repo=owner/name]` in the issue description or a comment. The latest mention wins.
2. A label in the issue's `repo` label group, named `owner/name`.
3. The same label on the parent issue.
4. The same label on the issue's project.
5. Linear's repository suggestions, when one repository is clearly ahead.
6. A question in Linear with up to three options.

Only repositories Paws has configured and can access count. A hint that names any other repository is skipped. Two matching labels on the same level make Paws ask with just those two.

## Set up repo labels

1. In Linear, open **Settings > Labels** and create a label group named `repo`.
2. Add one label per repository, named `owner/name`, for example `pmdroid/paws-app`.
3. Put the label on a project to set the default for its issues. Put a different label on a single issue to override it, for example a docs issue that belongs in another repository.

To choose a repository for one issue without a label, write `[repo=owner/name]` in its description or in a comment before you delegate it.
