# Local implementation skills

Give Paws project-specific skills from a folder on your machine. Add this to `~/.paws/config.toml`:

```toml
[skills.projects."owner/repo"]
root = "projects/work/skills"
```

Relative paths start at the Paws home directory. Absolute paths work too. Repository names match without regard to case.

Put each skill and its resources in a named directory:

```text
~/.paws/projects/work/skills/
  verify-work/
    SKILL.md
    scripts/check.sh
    references/environment.md
  coding-conventions/
    SKILL.md
```

Paws adds these instructions to each implementation and fix prompt. A local directory named `verify-work` takes precedence over the repository's `verify-work` skill, including skills under `.agents/skills` and `.claude/skills`. Other repository skills remain available. Paws keeps the original checkout, its index, and its tracked skills unchanged. Local instructions and resources stay outside candidate commits.

Skills can read resources by absolute path through file tools or `cat`. They can run scripts directly, for example `bash /absolute/path/verify-work/scripts/check.sh`, with the repository as the working directory. Scripts resolve their own sibling resources from their script directory. Paws grants access to the selected skill directories; edits to their resources and symlinks escaping those directories are denied.

The configured folder must live outside the repository and contain at least one skill. Paws checks it before starting an implementation agent. It accepts up to 100 skills with at most 1 MiB of combined `SKILL.md` instructions. Running setup again preserves these settings.

Closeout reviewers use the review skills supplied by the trusted Closeout policy. Keep acceptance review instructions with that policy and implementation instructions in this local skills folder.

For paired remote runners, Paws snapshots the complete skill folders and transfers a hash-bound private bundle with the assigned run. The runner restores resources in a temporary folder outside its checkout and renders skill paths for that machine. It removes that folder after the run. Bundles preserve binary resources and executable flags and accept up to 1,000 regular files within 20 MiB of encoded content.
