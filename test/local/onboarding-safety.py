import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time

repo = pathlib.Path(__file__).resolve().parents[2]
bun = os.environ["PAWS_BUN_BINARY"]
node = os.environ["PAWS_NODE_BINARY"]
finear = os.environ["PAWS_FINEAR_ROOT"]
root = pathlib.Path(tempfile.mkdtemp(prefix="paws-onboarding-safety-", dir="/var/tmp"))
results = []
for mode in ["interrupt", "timeout", "early"]:
    tree = repo
    if mode == "early":
        tree = root / "early-tree"
        shutil.copytree(repo, tree, symlinks=True, ignore=shutil.ignore_patterns(".git", "node_modules"))
        (tree / "node_modules").symlink_to((repo / "node_modules").resolve(), target_is_directory=True)
        source = tree / "test/local/onboarding-e2e.ts"
        text = source.read_text()
        expected = "  github.onToken ="
        if expected not in text:
            raise RuntimeError("Early-failure fixture entry point changed")
        source.write_text(text.replace(expected, '  await Bun.sleep(300);\n  throw new Error("controlled early fixture failure");\n' + expected, 1))
    home = root / mode / "home"
    home.mkdir(parents=True)
    (home / ".kyotoagent").mkdir()
    tmp = root / mode / "tmp"
    tmp.mkdir()
    if home.resolve() != home or (home / ".kyotoagent").resolve() != home / ".kyotoagent":
        raise RuntimeError("Disposable paths changed")
    env = {"HOME": str(home), "KYOTOAGENT_ROOT": str(home / ".kyotoagent"), "TMPDIR": str(tmp), "PATH": str(pathlib.Path(bun).parent) + ":" + str(pathlib.Path(node).parent) + ":/usr/bin:/bin", "PAWS_NODE_BINARY": node, "PAWS_FINEAR_ROOT": finear}
    if mode == "timeout":
        env["PAWS_VERIFY_TIMEOUT_MS"] = "5000"
    log = root / (mode + ".log")
    with log.open("w") as output:
        child = subprocess.Popen([bun, "--no-env-file", "scripts/verify-onboarding.ts"], cwd=tree, env=env, stdout=output, stderr=subprocess.STDOUT)
        seen = {}
        deadline = time.monotonic() + 80
        sent = False
        while child.poll() is None and time.monotonic() < deadline:
            parents = {}
            for file in pathlib.Path("/proc").glob("[0-9]*/stat"):
                try:
                    text = file.read_text()
                    fields = text[text.rfind(")") + 2:].split()
                    parents[int(file.parent.name)] = int(fields[1])
                except (OSError, ValueError):
                    pass
            owned = {child.pid}
            for _ in range(8):
                owned.update(pid for pid, parent in parents.items() if parent in owned)
            for pid in owned:
                try:
                    seen[pid] = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
                except OSError:
                    pass
            if mode == "interrupt" and not sent and "passed   vm.ready_without_selection" in log.read_text():
                child.send_signal(signal.SIGTERM)
                sent = True
            time.sleep(0.1)
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
            child.wait(timeout=45)
            raise RuntimeError("Bounded launcher probe did not finish")
    time.sleep(0.3)
    remaining = []
    for pid, command in seen.items():
        try:
            text = pathlib.Path(f"/proc/{pid}/stat").read_text()
            state = text[text.rfind(")") + 2:].split()[0]
            if state not in ["Z", "X"]:
                remaining.append({"pid": pid, "command": command, "state": state})
        except OSError:
            pass
    output = log.read_text()
    evidence_lines = [line for line in output.splitlines() if line.startswith("Isolated onboarding run: ")]
    evidence = pathlib.Path(evidence_lines[0].removeprefix("Isolated onboarding run: ")) if len(evidence_lines) == 1 else None
    observations = json.loads((evidence / "observations.json").read_text()) if evidence and (evidence / "observations.json").is_file() else None
    result = {"mode": mode, "exit": child.returncode, "signalled": sent, "observedProcesses": seen, "remaining": remaining, "log": str(log), "evidence": str(evidence) if evidence else None}
    results.append(result)
    (root / "observations.json").write_text(json.dumps(results, indent=2))
    if child.returncode == 0 or remaining or not observations or observations.get("result") != "failed":
        raise RuntimeError(json.dumps(result))
    cleanup = next((step for step in observations["steps"] if step["step"] == "cleanup.owned_processes_stopped"), None)
    if not cleanup or cleanup["status"] != "passed":
        raise RuntimeError("Owned cleanup was not observed: " + json.dumps(result))
    if mode == "interrupt" and not sent:
        raise RuntimeError("Interrupt trigger was never sent")
    if mode == "early":
        failure = next((step for step in observations["steps"] if step["step"] == "execution.exception"), None)
        if not failure or failure["status"] != "stopped" or failure.get("observed", {}).get("error") != "controlled early fixture failure" or "execution.exception" not in observations["failed"]:
            raise RuntimeError("Controlled early fixture exception was not observed")
        if not observations["owned"]["gitRemote"]["pid"] or not observations["gitRemote"].get("head") or not any("onboarding-git-server.ts" in command for command in seen.values()):
            raise RuntimeError("Early failure did not follow a real Git fixture start")
(root / "observations.json").write_text(json.dumps(results, indent=2))
print(root)
print(json.dumps([{"mode": result["mode"], "exit": result["exit"], "processes": len(result["observedProcesses"]), "remaining": result["remaining"]} for result in results], indent=2))
