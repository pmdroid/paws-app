import json
import os
import pathlib
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time


root = pathlib.Path("/state")
shutil.copytree("/input", root)
root.chmod(0o755)
assert (root / "daemon" / "identity" / "state.json").is_file()
helpers = json.loads((root / "fixture.json").read_text()).get("helpers", False)
for directory, uid, gid, mode in (("server", 1004, 1004, 0o700), ("daemon", 1001, 1001, 0o700), ("health", 1001, 1001, 0o700), ("spool", 1001, 1002, 0o2750), ("agent", 1002, 1002, 0o700), ("results", 0, 1003, 0o750)):
    target = root / directory
    target.mkdir(exist_ok=True)
    for path in (target, *target.rglob("*")):
        os.chown(path, uid, gid)
    target.chmod(mode)
(root / "agent" / "work").mkdir(mode=0o700)
os.chown(root / "agent" / "work", 1002, 1002)
workers = {}
started = []
stopped = []
actors = []
logs = []


def actor(mode, uid, execution_id=None):
    log = open(root / f"{mode}-{len(logs)}.log", "wb")
    logs.append(log)
    arguments = ["/proof/bun", "--no-env-file", "/proof/runtime.js", mode, str(root)]
    if execution_id:
        arguments.append(execution_id)
    process = subprocess.Popen(arguments, stdout=log, stderr=log, env={"PATH": "/usr/bin:/bin", "HOME": str(root / {1001: "daemon", 1002: "agent", 1004: "server"}[uid]), "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"}, user=uid, group=uid, extra_groups=[1002, 1003] if uid == 1001 else ([1003] if uid == 1002 else []), start_new_session=True)
    actors.append(process)
    return process


def control(operation, execution_id, template="paws-agent"):
    assert template == "paws-agent"
    if operation == "start":
        assert execution_id not in workers
        workers[execution_id] = actor("worker", 1002, execution_id)
        started.append(execution_id)
    elif operation in ("kill", "stop"):
        worker = workers.get(execution_id)
        if worker and worker.poll() is None:
            os.killpg(worker.pid, signal.SIGKILL)
            worker.wait(timeout=5)
        if operation == "stop":
            stopped.append(execution_id)
    elif operation == "show":
        assert not workers.get(execution_id) or workers[execution_id].poll() is not None
    return subprocess.CompletedProcess([], 0, stdout=b"")


def wait_for(predicate, process=None):
    deadline = time.monotonic() + 25
    while not predicate():
        assert time.monotonic() < deadline, "Native health timeout"
        assert process is None or process.poll() is None, "Native health process exited early"
        time.sleep(0.02)


def serve_workers(listener):
    admitted = set()
    finished = set()
    def dispatch(connection):
        try:
            payload = bytearray()
            while b"\n" not in payload:
                chunk = connection.recv(1025 - len(payload))
                if not chunk or len(payload) > 1024:
                    raise ValueError("Invalid worker request")
                payload.extend(chunk)
            request = json.loads(payload)
            execution_id = request["executionId"]
            if request["operation"] == "start":
                if execution_id in admitted or execution_id in finished:
                    response = {"ok": True, "alreadyAdmitted": True}
                else:
                    directory = root / "results" / execution_id
                    directory.mkdir(mode=0o750)
                    os.chown(directory, 1002, 1003)
                    directory.chmod(0o750)
                    response = {"ok": False} if control("start", execution_id).returncode else {"ok": True, "alreadyAdmitted": False}
                    if response["ok"]:
                        admitted.add(execution_id)
            elif request["operation"] == "stop":
                finished.add(execution_id)
                admitted.add(execution_id)
                response = {"ok": control("stop", execution_id).returncode == 0}
            else:
                response = {"ok": False}
            connection.sendall((json.dumps(response) + "\n").encode())
        except Exception:
            try:
                connection.sendall(b'{"ok":false}\n')
            except OSError:
                pass
        finally:
            connection.close()
    while True:
        connection, _ = listener.accept()
        threading.Thread(target=dispatch, args=(connection,), daemon=True).start()


listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(str(root / "broker.sock"))
os.chown(root / "broker.sock", 1001, 1001)
os.chmod(root / "broker.sock", 0o600)
listener.listen(16)
threading.Thread(target=serve_workers, args=(listener,), daemon=True).start()
try:
    coordinator = actor("coordinator", 1004)
    wait_for(lambda: (root / "server" / "ready").exists(), coordinator)
    daemon = actor("first", 1001)
    if helpers:
        wait_for(lambda: (root / "health" / "receipt-ready.json").exists(), daemon)
        os.killpg(daemon.pid, signal.SIGKILL)
        daemon.wait(timeout=5)
        pending_db = sqlite3.connect(root / "daemon" / "commands.db")
        pending_db.execute("UPDATE pending_command SET acknowledged=1")
        pending_db.commit()
        pending_db.close()
        recovered_receipt = actor("recover-receipt", 1001)
        assert recovered_receipt.wait(timeout=25) == 0
        assert len(started) == 1
        pending_db = sqlite3.connect(root / "daemon" / "commands.db")
        pending_db.execute("UPDATE pending_command SET acknowledged=1")
        pending_db.commit()
        pending_db.close()
        (root / "server" / "advance").write_text("advance")
        def helper_finished():
            state_db = sqlite3.connect(root / "server" / "paws.db")
            ended = state_db.execute("SELECT ended_at FROM runner_helper ORDER BY rowid LIMIT 1").fetchone()[0]
            state_db.close()
            return ended is not None
        wait_for(helper_finished, coordinator)
        daemon = actor("fence", 1001)
        wait_for(lambda: (root / "health" / "crash-ready.json").exists() and (root / "agent" / "held").exists(), daemon)
        fenced_execution = json.loads((root / "health" / "crash-ready.json").read_text())["executionId"]
        assert workers[fenced_execution].poll() is None
        (root / "server" / "fence").write_text("fence")
        assert daemon.wait(timeout=25) == 0
        assert (root / "server" / "fenced").exists()
        assert workers[fenced_execution].poll() is not None
        assert fenced_execution in stopped
        (root / "health" / "crash-ready.json").unlink()
        (root / "agent" / "held").unlink()
        (root / "server" / "resume").write_text("resume")
        daemon = actor("first", 1001)
    wait_for(lambda: (root / "health" / "crash-ready.json").exists() and (root / "agent" / "held").exists(), daemon)
    active = json.loads((root / "health" / "crash-ready.json").read_text())
    worker = workers[active["executionId"]]
    assert worker.poll() is None
    os.killpg(daemon.pid, signal.SIGKILL)
    daemon.wait(timeout=5)
    assert worker.poll() is None
    recovered = actor("recover", 1001)
    assert recovered.wait(timeout=25) == 0
    assert worker.poll() is not None
    assert active["executionId"] in stopped
    assert len(started) == len(set(started)) == 3
    completed = [execution_id for execution_id in started if execution_id != active["executionId"] and (not helpers or execution_id != fenced_execution)]
    for execution_id in completed:
        assert workers[execution_id].returncode in (0, -signal.SIGKILL)
        calls = json.loads((root / "agent" / (execution_id + "-agent.json")).read_text())["methods"]
        assert "initialize" in calls and "session/new" in calls
        assert ("session/prompt" in calls) == helpers
    coordinator.send_signal(signal.SIGTERM)
    assert coordinator.wait(timeout=5) == 0
    db = sqlite3.connect(root / "server" / "paws.db")
    if helpers:
        rows = db.execute("SELECT result FROM runner_helper WHERE result IS NOT NULL ORDER BY rowid").fetchall()
        assert len(rows) == 1
        result = json.loads(rows[0][0])
        assert result["text"] == "fixture helper response"
        assert result["agentExited"] and result["stopReason"] == "end_turn"
        assert not (root / "agent" / "forbidden-helper-write").exists()
        assert not list((root / "spool").glob("**/*.bundle"))
        db.close()
        print(json.dumps({"passed": True, "network": "none", "uids": {"coordinator": 1004, "daemon": 1001, "agent": 1002}, "signedHelperCommands": 3, "generationChangeStopsActualWorker": True, "mTlsReceipts": 1, "actualPromptReadOnly": True, "persistedBeforeNetwork": True, "normalPollRetriesStoredHelperAck": True, "terminalHelperAckCannotBlockNextAssignment": True, "lostResultReceiptAfterSigkillDrainsWithoutRelaunch": True, "repositoryBundles": 0, "crashedDaemonLeavesWorkerAlive": True, "reopenStopsInterruptedWorker": True, "executionsStarted": len(started), "relaunches": 0, "serviceBackend": "recording process-group backend"}))
    else:
        rows = db.execute("SELECT result_json FROM runner_health_result ORDER BY rowid").fetchall()
        db.close()
        assert len(rows) == 2
        results = [json.loads(row[0]) for row in rows]
        assert results[0]["models"][0]["id"] == "fixture-model"
        assert results[1]["login"] == {"agent": "claude", "authenticated": False, "method": "none"}, results[1]["login"]
        assert all(result["agentExited"] and result["stopReason"] == "end_turn" for result in results)
        print(json.dumps({"passed": True, "network": "none", "uids": {"coordinator": 1004, "daemon": 1001, "agent": 1002}, "signedHealthCommands": 3, "mTlsReceipts": len(results), "initializationWithoutPrompt": True, "crashedDaemonLeavesWorkerAlive": True, "reopenStopsInterruptedWorker": True, "executionsStarted": len(started), "relaunches": 0}))
finally:
    for process in actors:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    for log in logs:
        log.close()
    for path in sorted(root.glob("*.log")):
        content = path.read_text()
        if content:
            print(path.name + "\n" + content, file=sys.stderr)
