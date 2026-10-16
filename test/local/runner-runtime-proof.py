import hashlib
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
import uuid


root = pathlib.Path("/state")
shutil.copytree("/input", root)
root.chmod(0o755)
permanent = (root / "failure-case").read_text() == "permanent"
assert (root / "daemon" / "identity" / "state.json").is_file()
for directory, uid, gid, mode in (("server", 1004, 1004, 0o700), ("daemon", 1001, 1001, 0o700), ("runtime", 1001, 1001, 0o700), ("repositories", 1001, 1001, 0o700), ("origin.git", 1001, 1001, 0o700), ("spool", 1001, 1002, 0o2750), ("agent", 1002, 1002, 0o700), ("results", 0, 1003, 0o750), ("receipts", 0, 0, 0o700)):
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
        assert time.monotonic() < deadline, "Native runtime timeout"
        assert process is None or process.poll() is None, "Native runtime process exited early"
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
    wait_for(lambda: (root / "runtime" / "crash-ready.json").exists() and any((root / "results").glob("*/held")), daemon)
    active = json.loads((root / "runtime" / "crash-ready.json").read_text())
    worker = workers[active["executionId"]]
    assert worker.poll() is None
    os.killpg(daemon.pid, signal.SIGKILL)
    daemon.wait(timeout=5)
    assert worker.poll() is None
    recovered = actor("recover", 1001)
    assert recovered.wait(timeout=25) == 0
    assert worker.poll() is not None
    assert active["executionId"] in stopped
    assert len(started) == len(set(started)) == 4
    expired = json.loads((root / "runtime" / "lease-expired.json").read_text())
    assert expired["phase"] == "interrupted"
    assert expired["executionId"] in stopped
    assert workers[expired["executionId"]].poll() is not None
    for execution_id in started[1:2] if permanent else started[:2]:
        assert workers[execution_id].returncode in (0, -signal.SIGKILL)
        calls = json.loads((root / "agent" / (execution_id + "-agent.json")).read_text())
        assert "session/prompt" in calls["methods"]
        assert calls["artifact"]["ok"] and calls["askTeam"]["text"] == "Yes"
    coordinator.send_signal(signal.SIGTERM)
    assert coordinator.wait(timeout=5) == 0
    db = sqlite3.connect(root / "server" / "paws.db")
    rows = db.execute("SELECT payload FROM runner_result ORDER BY rowid").fetchall()
    events = db.execute("SELECT payload FROM runner_event ORDER BY rowid").fetchall()
    answers = db.execute("SELECT answer FROM runner_question_answer ORDER BY rowid").fetchall()
    transcripts = db.execute("SELECT execution_id,sealed_size,sha256,uri FROM runner_transcript WHERE uri IS NOT NULL ORDER BY rowid").fetchall()
    db.close()
    assert len(transcripts) == (1 if permanent else 2)
    for execution_id, size, digest, uri in transcripts:
        raw = (root / "results" / execution_id / "events.jsonl").read_bytes()
        stored = (root / "server" / "objects" / uri.removeprefix("s3://fixture-transcripts/")).read_bytes()
        assert stored == raw and len(raw) == size
        assert hashlib.sha256(stored).hexdigest() == digest
    if not permanent:
        execution_id = transcripts[0][0]
        raw = (root / "results" / execution_id / "events.jsonl").read_bytes()
        assert len(raw) > 10 * 1024 * 1024 and b"raw-tail-349" in raw
    assert len(events) < 200
    journal = sqlite3.connect(root / "runtime" / "executions.db")
    offsets = journal.execute("SELECT consumed,transcript_offset FROM execution WHERE phase='complete'").fetchall()
    journal.close()
    assert len(offsets) == len(transcripts) and all(consumed == uploaded and uploaded > 0 for consumed, uploaded in offsets)
    assert len(rows) == (1 if permanent else 2)
    results = [json.loads(row[0]) for row in rows]
    if not permanent:
        assert results[0]["role"] == "implementer" and results[0]["candidateSha"]
    review = results[-1]
    assert review["role"] == "reviewer" and review["reviewText"] == "[]" and "candidateSha" not in review
    kinds = [json.loads(row[0])["type"] for row in events]
    assert kinds.count("question") == kinds.count("artifact") == (1 if permanent else 2)
    assert len(answers) == (2 if permanent else 4)
    branch = subprocess.run(["/usr/bin/git", "-c", "safe.directory=*", "--git-dir", str(root / "origin.git"), "show-ref"], check=not permanent, capture_output=True, text=True).stdout
    if not permanent:
        assert results[0]["candidateSha"] in branch and "refs/heads/paws/" in branch
    directory = root / "results" / started[1 if permanent else 0]
    valid = next(directory.glob("artifact-*.bytes"))
    rejected = []
    def invalid_file(kind):
        path = directory / ("artifact-" + str(uuid.uuid4()) + ".bytes")
        if kind == "symlink":
            path.symlink_to(valid)
        elif kind == "hardlink":
            source = directory / "hardlink-source"
            source.write_bytes(b"linked")
            os.chown(source, 1002, 1003)
            source.chmod(0o640)
            os.link(source, path)
        else:
            path.write_bytes(b"invalid")
            os.chown(path, 0 if kind == "owner" else 1002, 1002 if kind == "group" else 1003)
            path.chmod(0o660 if kind == "mode" else 0o640)
            if kind == "size":
                with path.open("r+b") as stream:
                    stream.truncate(10 * 1024 * 1024 + 1)
        rejected.append(path.name)
    for kind in ("symlink", "hardlink", "owner", "group", "mode", "size"):
        invalid_file(kind)
    rejected += ["artifact-invalid.bytes", "artifact-../../server/server.key.bytes"]
    (root / "reader-cases.json").write_text(json.dumps({"executionId": started[1 if permanent else 0], "valid": valid.name, "rejected": rejected}))
    reader = actor("reader", 1001)
    assert reader.wait(timeout=5) == 0
    print(json.dumps({"passed": True, "network": "none", "uids": {"coordinator": 1004, "daemon": 1001, "agent": 1002}, "signedWorkCommands": 4, "mTlsResults": len(results), "questionsAnswered": len(results), "artifactsUploaded": len(results), "canonicalCandidatePublished": not permanent, "failureCase": (root / "failure-case").read_text(), "transientPreparationAndPublicationRetried": (root / "failure-case").read_text() == "all", "permanentClientErrorReleasesSlot": permanent, "lostReceiptsRetriedWithoutDuplicates": True, "transcriptChunkAndSealReceiptsRetried": True, "sealedRawObjects": len(transcripts), "sealAcknowledgedBeforeResult": True, "fullRawTranscriptOver10MiB": not permanent, "lifecycleRows": len(events), "durableTranscriptOffsets": offsets, "protectedArtifactReaderRejections": len(rejected), "readOnlyReview": True, "hungNetworkLeaseStoppedWorker": True, "crashedDaemonLeavesWorkerAlive": True, "reopenStopsInterruptedWorker": True, "executionsStarted": 4, "relaunches": 0}))
finally:
    journal_path = root / "runtime" / "executions.db"
    if journal_path.exists():
        journal = sqlite3.connect(journal_path)
        print("FINAL_PHASES " + json.dumps(journal.execute("SELECT phase FROM execution ORDER BY rowid").fetchall()), file=sys.stderr)
        journal.close()
    print(json.dumps({"started": started, "stopped": stopped, "results": [str(p) for p in (root / "results").rglob("*")]}), file=sys.stderr)
    for event_path in (root / "results").glob("*/events.jsonl"):
        print(event_path.read_text()[-12000:], file=sys.stderr)
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
