# runtimes-demo

Repository used to smoke-test runner runtimes. `mise.toml` asks for Node 22 and Python 3.12. The Closeout checks in `.agents/closeout.yaml` run `node --version` and `python --version` and fail unless the major versions match, so a runner that ignores `mise.toml` cannot pass them with a system Node or Python.

The runner's own Bun is not on the task's `PATH`, and this repository does not declare Bun, so nothing here needs it.

Push this directory to an empty GitHub repository as its `main`, connect it to Paws, and follow [Runtimes in the smoke test](../../docs/smoke-test.md#runtimes).
