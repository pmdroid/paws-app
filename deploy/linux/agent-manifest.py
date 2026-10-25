"""Write deploy/linux/agents.json: the coding agent pins the runner installer installs from npm.

Each agent's lockfile is resolved from the repository bun.lock, so every package keeps the version
and sha512 integrity already reviewed there. Run after changing an agent version in package.json:

    python3 -I -B deploy/linux/agent-manifest.py --bun "$(command -v bun)"
"""

import argparse
import importlib.util
import json
import pathlib
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("paws_release", ROOT / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def agent_entry(bun, agent, version, workspace, seed=None, registry=None):
    """Resolve one agent's lockfile. `seed` is a bun.lock whose resolutions are kept; `registry` replaces npm (tests)."""
    return release.agent_entry(bun, agent, version, workspace, seed, registry)


def build(arguments):
    source = pathlib.Path(arguments.source).resolve(strict=True)
    pins = json.loads((source / "package.json").read_text())["dependencies"]
    agents = {}
    for agent, package in sorted(release.AGENT_PACKAGES.items()):
        version = pins[package]
        if not release.EXACT_VERSION.fullmatch(version):
            raise ValueError(f"package.json must pin {package} to an exact version")
        with tempfile.TemporaryDirectory(prefix=f"paws-agent-{agent}-") as workspace:
            agents[agent] = agent_entry(pathlib.Path(arguments.bun), agent, version, pathlib.Path(workspace), (source / "bun.lock").read_bytes())
    content = json.dumps({"format": 1, "agents": agents}, indent=2, sort_keys=True) + "\n"
    release.parse_agent_manifest(content)
    pathlib.Path(arguments.output).write_text(content)
    return {agent: entry["version"] for agent, entry in agents.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--source", default=str(ROOT.parent.parent))
    parser.add_argument("--output", default=str(ROOT / "agents.json"))
    print(json.dumps(build(parser.parse_args())))


if __name__ == "__main__":
    main()
