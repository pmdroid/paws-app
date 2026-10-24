"""Write deploy/linux/agents.json: the coding agent pins the runner installer installs from npm.

Each agent's lockfile is resolved from the repository bun.lock, so every package keeps the version
and sha512 integrity already reviewed there. Run after changing an agent version in package.json:

    python3 -I -B deploy/linux/agent-manifest.py --bun "$(command -v bun)"
"""

import argparse
import importlib.util
import json
import pathlib
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("paws_release", ROOT / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def agent_entry(bun, agent, version, workspace, seed=None, registry=None):
    """Resolve one agent's lockfile. `seed` is a bun.lock whose resolutions are kept; `registry` replaces npm (tests)."""
    package = release.agent_package_json(agent, version)
    (workspace / "package.json").write_text(json.dumps(package))
    if seed is not None:
        (workspace / "bun.lock").write_bytes(seed)
    home = workspace / "home"
    home.mkdir()
    completed = subprocess.run(
        [str(bun), "install", "--lockfile-only", "--ignore-scripts"],
        cwd=workspace,
        env={**release.COMMAND_ENV, "HOME": str(home), **({"BUN_CONFIG_REGISTRY": registry} if registry else {})},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=600,
    )
    if completed.returncode != 0:
        raise ValueError(f"Could not resolve the {agent} lockfile: {completed.stderr.decode(errors='replace')[-800:]}")
    lockfile = release.parse_lockfile((workspace / "bun.lock").read_text())
    lockfile["workspaces"] = {"": {"name": package["name"], "dependencies": package["dependencies"]}}
    lockfile.pop("trustedDependencies", None)
    packages = []
    for path, locked in sorted(lockfile["packages"].items()):
        # The installer always names the registry itself; a lockfile entry never points at a tarball URL.
        if registry and isinstance(locked[1], str) and locked[1].startswith(registry):
            locked[1] = ""
        name, _, exact = locked[0].rpartition("@")
        packages.append({"path": path, "name": name, "version": exact, "integrity": locked[3]})
    return {"package": release.AGENT_PACKAGES[agent], "version": version, "packages": packages, "lockfile": lockfile}


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
