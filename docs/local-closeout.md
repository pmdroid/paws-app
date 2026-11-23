# Local Closeout policy

Keep the Closeout policy for a work repository on your machine. [Review checks and evidence](closeout.md) explains verification. Save the repository's policy folder in Settings > Closeout. See [Closeout settings](configuration.md#closeout).

The project key is the GitHub `owner/repo`, matched without case sensitivity. `policyRoot` is an absolute directory on the Paws host. A save applies without restarting Paws.

Create this directory layout:

```text
~/.paws/projects/widgets/
  .agents/
    closeout.yaml
    checks.yaml
    skills/
      review/
        SKILL.md
        references/
          rules.md
```

For example, `.agents/closeout.yaml` can contain:

```yaml
specVersion: "0.1"
imports:
  - as: team
    path: .agents/checks.yaml
items:
  - id: review
    kind: review
    gate: beforePR
    skill: .agents/skills/review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
```

Put repository checks in `.agents/checks.yaml`:

```yaml
specVersion: "0.1"
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test"]
    timeoutSeconds: 120
```

Write the review instructions in `SKILL.md` and supporting text in `references/rules.md`. Import and skill paths resolve from `policy_root`. Commands run against the candidate checkout.

The local policy replaces the repository policy for that project. Paws blocks verification if the configured local policy is missing or invalid. Setup preserves this setting and validates the local policy without creating `.agents/closeout.yaml` in the work repository. Run `bun run paws doctor` to check the selected policy.

Changing the policy or its review instructions requires fresh verification. Review results identify the selected local policy. Paired runners use the same policy, with commands executed against the candidate checkout.

Checks, rules and setup steps can use `paths` to limit which changed files trigger them. The optional `except` list requires `paths` and excludes matching files from that scope. Both lists use repository-relative patterns: `*` and `?` match within a segment, `**` matches across segments, and a trailing `/` matches a prefix. For example, `paths: ["src/dashboard/**"]` with `except: ["**/*.test.ts"]` requires visual proof for dashboard source changes but skips test-only changes.

The entry policy can say what a restart runs again with an optional `rerun` key. An imported file that contains `rerun` does not load.

```yaml
rerun:
  conflict:
    run: [lint, typecheck, test]
    reviews: false
  ci:
    run: failed
```

`rerun.conflict.run` lists the command checks to run after a conflict fix. Each id must name a `kind: command` check in the policy, and an imported check uses its prefixed id, such as `team/test`. `rerun.conflict.reviews` defaults to `true`. `rerun.ci.run` is `all` (the default) or `failed`. Any other key under `rerun` makes the policy invalid.

After a restart that only resolves a merge conflict, the fixed commit runs only the `rerun.conflict.run` checks, and the other command checks that passed on the accepted commit are carried from it. With `reviews: false`, the reviews that passed there are carried too. Carried checks show "carried from <commit>: passed there, not run again after the conflict fix". This applies only when the accepted, not high-risk pull request came back from the merge queue to rebase with nothing else to fix, **When main moved before the merge** is not Closeout, main's policy is the one the accepted commit was verified with, every listed id ran on the accepted commit, CI is green on the fixed commit, the checks the turn ran there used the same policy, and the fix changes no file the accepted commit did not. Otherwise every check and review runs. GitHub CI must still pass on the fixed commit before the merge.

A command check can also have `since`, the command to run when the check only has to cover changes made after an earlier commit. It is an argv like `exec` and needs exactly one element that is `{since}`, for example `since: ["bun", "scripts/test-since.ts", "{since}"]`. Only command checks accept `since`.

A command check can have `select` to let the runner read each failed test from the test report. `select.runner` names the test runner: `bun`, `vitest`, `jest`, `go`, `cargo`, `nextest` or `pytest`. With `bun`, `vitest` or `jest`, `exec` must start with `bun test`, with `vitest run` (or `npx vitest run`, `bunx vitest run`) or with `jest` (or `npx jest`, `bunx jest`), and pass only flags, written as `--flag=value`. The runner adds a JUnit reporter and a report file to `exec`: `--reporter=junit` for `bun`, `--reporter=default --reporter=junit --outputFile=…` for `vitest`, and `--reporters=default --reporters=jest-junit` with `JEST_JUNIT_OUTPUT_DIR` for `jest`, which needs the `jest-junit` package installed where the check runs; without it the check fails with "jest-junit is not installed". The check passes only when the command exits 0 and the report lists tests and no failures. A missing or unreadable report fails the check. A failed check lists up to 50 failed tests, by file and name, ahead of the end of the output. These three runners run only the test files a change affects: those whose imports reach a changed, added, deleted or renamed file at the base or at the head, plus the files in `always`. It follows relative imports, re-exports, literal dynamic `import()` and `require()`, workspace packages from the root `package.json` `workspaces` and `paths` aliases from the root `tsconfig.json`; imported JSON, CSS and assets count as files. It runs the whole suite instead when a file the tests reach has a non-literal `import()` or `require()` or an import it can't follow, when `package.json`, a lockfile, `tsconfig*.json`, `bunfig.toml` or a `preload` file from `bunfig.toml` changes, for `vitest` when `vitest.config.*` or `vite.config.*` changes, for `jest` when `jest.config.*` or `babel.config.*` changes, when a changed file inside the check's `paths` has a type it doesn't know, when a changed file matches `full_on`, when more files than `max_selected` are selected, or when no file is selected and `always` is empty. An `always` entry that doesn't exist at the head fails the check. A check can't have both `select` and `since`, and only command checks accept `select`. Runners need version 0.1.102 or newer for `select`.

With `select.runner: go`, `exec` must be `go test` with flags written as `-flag=value` and exactly one package pattern, `./...`, without `-args`. The runner lists the packages at the base and at the head with `go list -deps -test -json ./...`, using `exec`'s `-tags`, `-mod`, `-modfile`, `-race`, `-msan`, `-asan`, `-overlay`, `-pgo` and `-compiler` and the check's environment, so `GOFLAGS`, `GOOS`, `GOARCH` and `GOWORK` apply. A changed file belongs to the package that lists it, including its tests, cgo and assembly sources and embedded files, or whose `testdata/` holds it. The runner tests each changed package and every package that depends on one or whose tests do, in either listing, plus the packages in `always`, by running `exec` with `-json` and `./...` replaced by those import paths. It runs every package instead when `go list` fails, `go.mod`, `go.sum`, `go.work` or `go.work.sum` changed, a changed file matches `full_on`, no package owns a changed file, a changed file can't be read, a changed file is generated (`// Code generated … DO NOT EDIT.`) or has a `//go:generate` line, more packages than `max_selected` are affected, or none are and `always` is empty. The check fails on a failed test, a failed build, a package without a final pass or fail, or a stream that ends early, and lists each failure by package and test name.

With `select.runner: pytest`, `exec` must run pytest as `pytest`, `python -m pytest`, `uv run pytest` or `poetry run pytest` and pass only options, written as `--option=value`, without test paths, `-k` or `--junitxml`. The runner adds `-o junit_family=xunit1` and `--junitxml` with a report file to `exec`. The check fails on a failed test, a collection error or a missing report, and lists each failure by file and name.

The pytest runner runs only the test files a change affects when `select.package_roots` lists the folders, relative to the repository root, whose contents are importable top-level packages, for example `["src"]`, `["."]` or `["libs/core/src", "libs/sdk/src"]`; without it, it always runs the whole suite. Test files are those pytest collects by default, `test_*.py` and `*_test.py`. The runner reads every Python file's imports at the base and at the head with the check's own Python (`python3`, or `python` through `uv run` or `poetry run` when `exec` uses them) and the standard `ast` module. It follows `import a.b`, `from a.b import c`, relative imports, the `__init__.py` of each package on the way, modules beside each test file in its first folder without `__init__.py`, and the `conftest.py` files above each test; imports that resolve nowhere under those folders count as third party and are ignored. It runs `exec` with the selected test files and the files in `always`. It runs the whole suite instead when a `conftest.py`, `pyproject.toml`, `uv.lock`, `poetry.lock`, `requirements*.txt`, `setup.py`, `setup.cfg`, `pytest.ini` or `tox.ini` changes, when one of those config files sets `python_files`, when a file the tests reach calls `importlib.import_module`, `__import__`, `importlib.metadata.entry_points` or `pkgutil`'s module walkers, or doesn't parse, when a folder under `package_roots` holds Python files but no `__init__.py`, when a changed file under `package_roots` isn't a `.py` file, when a changed file matches `full_on`, when more files than `max_selected` are selected, or when no file is selected and `always` is empty.

With `select.runner: cargo`, `exec` must start with `cargo`, `test` and pass only flags before `--`, written as `--flag=value`, without `-p`, `--package` or `--workspace`. `cargo test` writes no report, so the result is its exit status, and the check's result says so.

With `select.runner: nextest`, `exec` must start with `cargo`, `nextest`, `run` under the same rules, and without `--profile`. The runner adds `--tool-config-file` and `--profile=paws:closeout`, a profile that writes JUnit and inherits the repository's default profile; a nextest that doesn't accept them fails the check for a missing report.

For `cargo` and `nextest`, the runner runs `cargo metadata` at the base and the head with the features, `--target` and `--manifest-path` of `exec`. A changed file belongs to the workspace crate whose folder holds it, tests, benches and examples included. The runner adds one `-p` for each changed crate, each workspace crate that depends on it in either graph, directly or through other packages, and each crate in `always`. It runs every crate instead, adding `--workspace`, when `cargo metadata` fails, a `Cargo.toml`, `Cargo.lock`, `build.rs`, `.cargo/config.toml` or `rust-toolchain` file changed, a changed file matches `full_on`, a changed crate is a proc-macro or has a build script, no workspace crate owns a changed file, more crates than `max_selected` are selected, or nothing is selected.

With `rerun.ci.run: failed`, the fix after failed GitHub CI on a commit Closeout accepted runs only what the failure needs. Each command check whose `ci:` pattern matches a failed CI check runs its `since` command with `{since}` set to that commit, or its `exec` without `since`. The other command checks that passed there are carried when the fix changes none of the files in their `paths`; reviews, evidence and rules run as before. This applies only when Paws recorded the failed CI checks for that commit, every one of them matches a `ci:` pattern, main's policy is the one the commit was verified with, and the checks the turn ran used the same policy. Otherwise every check runs. GitHub CI must still pass on the fixed commit before the merge.

Runners need version 0.1.102 or newer for these keys; Paws places work only on such runners.
