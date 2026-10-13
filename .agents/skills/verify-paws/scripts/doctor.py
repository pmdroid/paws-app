import argparse
import hashlib
import http.client
import json
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def command(*args, env=None):
    return subprocess.check_output(args, timeout=10, env=env)


parser = argparse.ArgumentParser(description="Read-only doctor for an owned Paws browser fixture.")
parser.add_argument("evidence", type=Path)
args = parser.parse_args()
root = args.evidence.resolve(strict=True)
manifest = json.loads((root / "manifest.json").read_text())
mode = manifest["mode"]
require(mode in ("serve", "workspace-serve"), "Doctor needs a running browser fixture.")
require(Path(manifest["repo"]).resolve() == Path.cwd().resolve(), "Run from the fixture checkout.")
require(manifest["home"] == str(root / "home"), "Evidence and isolated home do not match.")
bun = shutil.which("bun")
require(bun is not None, "Bun must be on PATH.")
git_environment = {
    "PATH": f"{Path(bun).resolve().parent}:/usr/bin:/bin",
    "HOME": manifest["home"],
    "XDG_CONFIG_HOME": str(root / "home" / ".config"),
    "TMPDIR": str(root / "tmp"),
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
}
require(
    command("git", "rev-parse", "HEAD", env=git_environment).decode().strip() == manifest["gitSha"],
    "HEAD changed.",
)
require(
    hashlib.sha256(command("git", "diff", "HEAD", env=git_environment)).hexdigest()
    == manifest["trackedDiffSha256"],
    "Tracked source changed. Relaunch before collecting proof.",
)
require(command("bun", "--version").decode().strip() == manifest["bun"], "Bun version changed.")
if mode == "workspace-serve":
    origin = json.loads((root / "workspace-ui.json").read_text())["origin"]
    entry = "test/local/workspace-ui.ts"
else:
    logs = "\n".join(path.read_text() for path in sorted(root.glob("command-*.log")))
    matches = re.findall(r"Throwaway dashboard: (http://127\.0\.0\.1:\d+)/status", logs)
    require(len(matches) == 1, "Wait for the Throwaway dashboard readiness line.")
    origin = matches[0]
    entry = "test/local/instance.ts"
url = urlsplit(origin)
require(url.scheme == "http" and url.hostname == "127.0.0.1" and url.port, "Expected loopback HTTP.")
listeners = command("ss", "-H", "-ltnp", "sport", "=", str(url.port)).decode().splitlines()
owners = [line for line in listeners if line.split()[3] == f"127.0.0.1:{url.port}"]
require(len(owners) == 1, "Fixture listener is missing or ambiguous.")
pids = set(re.findall(r"pid=(\d+)", owners[0]))
require(len(pids) == 1, "Cannot identify the fixture listener owner.")
pid = int(pids.pop())
proc = Path("/proc") / str(pid)
require((proc / "cwd").resolve() == Path.cwd().resolve(), "Listener belongs to another checkout.")
argv = (proc / "cmdline").read_bytes().split(b"\0")
require(entry.encode() in argv, "Listener is not the expected fixture process.")
environment = (proc / "environ").read_bytes().split(b"\0")
for key, value in (("PAWS_VERIFY_ROOT", root), ("HOME", root / "home")):
    require(f"{key}={value}".encode() in environment, f"Listener has the wrong {key}.")


def read_json(path, status=200):
    connection = http.client.HTTPConnection("127.0.0.1", url.port, timeout=5)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        require(response.status == status, f"Unexpected HTTP {response.status} for {path}.")
        return json.loads(response.read())
    finally:
        connection.close()


if mode == "serve":
    saved = json.loads((root / "happy.json").read_text())
    snapshot = read_json("/api/status")
    require(snapshot["source"] == "live", "Dashboard is not reading live state.")
    require(
        sorted(item["id"] for item in snapshot["items"])
        == sorted(item["id"] for item in saved["snapshot"]["items"]),
        "Dashboard items do not match the saved fixture.",
    )
    fixture = read_json("/__fixture")
    require(all(fixture[key] == saved[key] for key in ("comments", "pulls", "merged")), "Fixture mismatch.")
else:
    require(read_json("/health") == {"ok": True, "service": "paws"}, "Unexpected service health.")
    read_json("/api/auth/session", 401)
print(json.dumps({"ok": True, "mode": mode, "pid": pid, "origin": origin, "evidence": str(root), "gitSha": manifest["gitSha"]}))
