import importlib.util
import ctypes
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest


spec = importlib.util.spec_from_file_location("broker", sys.argv[1])
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
EXECUTION_ID = "01K00000000000000000000000"


@unittest.skipUnless(os.getuid() == 0, "Disposable root namespace required")
class BrokerProof(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="paws-broker-proof-"))
        self.root.chmod(0o755)
        broker.SPOOL = str(self.root / "spool")
        broker.RESULTS = str(self.root / "results")
        broker.UNIT = str(self.root / "worker.service")
        for path, uid, gid, mode in ((broker.SPOOL, 1001, 1002, 0o2750), (broker.RECEIPTS, 0, 0, 0o700), (broker.RESULTS, 0, 1003, 0o750)):
            os.mkdir(path)
            os.chown(path, uid, gid)
            os.chmod(path, mode)
        pathlib.Path(broker.UNIT).write_text("[Service]\nKillMode=control-group\n")
        self.directory = pathlib.Path(broker.SPOOL) / EXECUTION_ID
        self.directory.mkdir()
        os.chown(self.directory, 1001, 1002)
        self.directory.chmod(0o750)
        self.job = self.directory / "job.json"
        self.job.write_text(json.dumps({"executionId": EXECUTION_ID, "command": {"type": "probe", "expiresAt": int(time.time() * 1000) + 120000}}))
        os.chown(self.job, 1001, 1002)
        self.job.chmod(0o640)
        self.calls = []
        self.delay = 0
        self.start_timeout = False
        self.stop_timeout = False
        self.kill_timeout = False
        self.group = b""
        self.timer_active = False
        private = self.root / "private"
        private.mkdir(mode=0o700)
        (private / "identity").write_text("synthetic identity")
        (private / "identity").chmod(0o600)
        os.chown(private / "identity", 1001, 1001)
        os.chown(private, 1001, 1001)
        self.original_run = broker.subprocess.run
        def run(arguments, **options):
            self.calls.append((arguments, options))
            time.sleep(self.delay)
            if self.start_timeout and arguments[1] == "start":
                raise subprocess.TimeoutExpired(arguments, options["timeout"])
            if self.kill_timeout and arguments[1] == "kill":
                raise subprocess.TimeoutExpired(arguments, options["timeout"])
            if self.stop_timeout and arguments[1] == "stop":
                raise subprocess.TimeoutExpired(arguments, options["timeout"])
            if arguments[0] == "/usr/bin/systemd-run":
                self.timer_active = True
            if arguments[1] == "is-active":
                return subprocess.CompletedProcess(arguments, 0 if self.timer_active else 3)
            return subprocess.CompletedProcess(arguments, 0, stdout=self.group)
        broker.subprocess.run = run

    def tearDown(self):
        broker.subprocess.run = self.original_run
        shutil.rmtree(self.root)
        shutil.rmtree(broker.RECEIPTS)

    def request(self, payload, uid=1001):
        path = str(self.root / "broker.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        os.chmod(path, 0o777)
        listener.listen(1)
        read_pipe, write_pipe = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(read_pipe)
                listener.close()
                os.setgroups([1002, 1003])
                os.setgid(uid)
                os.setuid(uid)
                if uid == 1002:
                    try:
                        (self.root / "private" / "identity").read_bytes()
                        raise RuntimeError("Agent read daemon identity")
                    except PermissionError:
                        pass
                connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.connect(path)
                start = time.monotonic()
                connection.sendall(payload)
                connection.shutdown(socket.SHUT_WR)
                response = bytearray()
                while True:
                    try:
                        chunk = connection.recv(1024)
                    except ConnectionResetError:
                        break
                    if not chunk:
                        break
                    response.extend(chunk)
                os.write(write_pipe, json.dumps({"response": json.loads(response) if response else {"ok": False}, "elapsed": time.monotonic() - start}).encode())
                os._exit(0)
            except BaseException:
                os._exit(1)
        os.close(write_pipe)
        try:
            connection, _ = listener.accept()
            handler = os.fork()
            if handler == 0:
                try:
                    os.setgroups([1002, 1003])
                    header = (ctypes.c_uint32 * 2)(0x20080522, 0)
                    capabilities = (ctypes.c_uint32 * 6)(1, 1, 0, 0, 0, 0)
                    if ctypes.CDLL(None, use_errno=True).capset(header, capabilities) != 0:
                        raise OSError(ctypes.get_errno())
                    try:
                        (self.root / "private" / "identity").read_bytes()
                        raise RuntimeError("Broker read daemon identity")
                    except PermissionError:
                        pass
                    broker.handle(connection, 1001, 1002, 1002, 1003)
                    (self.root / "calls.json").write_text(json.dumps(self.calls))
                    os._exit(0)
                except BaseException:
                    os._exit(1)
            connection.close()
            _, handler_status = os.waitpid(handler, 0)
            self.assertEqual(handler_status, 0)
            self.calls = json.loads((self.root / "calls.json").read_text())
            result = os.read(read_pipe, 4096)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(status, 0)
            return json.loads(result)
        finally:
            os.close(read_pipe)
            listener.close()
            os.unlink(path)

    def command(self, operation="start", uid=1001):
        return self.request(json.dumps({"operation": operation, "executionId": EXECUTION_ID}).encode() + b"\n", uid)["response"]

    def test_real_peer_uid_denies_agent_even_with_socket_access(self):
        self.assertEqual(self.command(uid=1002), {"ok": False})
        self.assertEqual(self.calls, [])
        self.assertEqual(list(pathlib.Path(broker.RECEIPTS).iterdir()), [])

    def test_fixed_start_is_admitted_once_after_completion(self):
        self.assertEqual(self.command(), {"ok": True, "alreadyAdmitted": False})
        self.assertEqual(self.command(), {"ok": True, "alreadyAdmitted": True})
        self.assertEqual(len(self.calls), 1)
        arguments, options = self.calls[0]
        self.assertEqual(arguments, ["/usr/bin/systemctl", "start", "--", f"paws-agent@{EXECUTION_ID}.service"])
        self.assertEqual(options["env"], {"PATH": "/usr/bin:/bin", "LANG": "C"})
        self.assertFalse(options.get("shell", False))
        result = os.stat(pathlib.Path(broker.RESULTS) / EXECUTION_ID)
        self.assertEqual((result.st_uid, result.st_gid, result.st_mode & 0o777), (1002, 1003, 0o750))

    def test_start_timeout_stops_unit_before_failure_acknowledgement(self):
        self.start_timeout = True
        self.delay = 0.05
        result = self.request(json.dumps({"operation": "start", "executionId": EXECUTION_ID}).encode() + b"\n")
        self.assertEqual(result["response"], {"ok": False})
        self.assertEqual([call[0][1] for call in self.calls], ["start", "kill", "stop", "show"])
        self.assertGreaterEqual(result["elapsed"], 0.09)
        self.assertEqual(self.command(), {"ok": True, "alreadyAdmitted": True})
        self.assertEqual([call[0][1] for call in self.calls], ["start", "kill", "stop", "show"])

    def test_stop_timeout_never_acknowledges_death_and_keeps_its_fence(self):
        self.stop_timeout = True
        self.assertEqual(self.command("stop"), {"ok": False})
        self.assertTrue((pathlib.Path(broker.RECEIPTS) / (EXECUTION_ID + ".stopped")).is_file())
        self.assertEqual(self.command(), {"ok": True, "alreadyAdmitted": True})
        self.assertEqual([call[0][1] for call in self.calls], ["kill", "stop"])

    def test_kill_timeout_still_requires_fixed_stop_and_empty_cgroup(self):
        self.kill_timeout = True
        self.assertEqual(self.command("stop"), {"ok": True})
        self.assertEqual([call[0][1] for call in self.calls], ["kill", "stop", "show"])
        self.assertEqual([call[1]["timeout"] for call in self.calls], [5, 45, 5])

    def test_stop_rejects_unsafe_cgroup_confirmation(self):
        self.group = b"/../../untrusted"
        self.assertEqual(self.command("stop"), {"ok": False})
        self.assertTrue((pathlib.Path(broker.RECEIPTS) / (EXECUTION_ID + ".stopped")).is_file())

    def test_expiry_binds_the_admitted_command_and_arms_a_fixed_timer(self):
        command = json.loads(self.job.read_text())["command"]
        self.assertTrue(broker.admit_once(EXECUTION_ID, command))
        self.assertFalse(broker.admit_once(EXECUTION_ID, command))
        with self.assertRaises(ValueError):
            broker.admit_once(EXECUTION_ID, {**command, "expiresAt": command["expiresAt"] + 1000})
        with broker.lifecycle(EXECUTION_ID) as directory:
            self.assertEqual(broker.expiry_receipt(directory, EXECUTION_ID)["expiresAt"], command["expiresAt"])
            self.assertTrue(broker.arm_deadline(directory, EXECUTION_ID))
            self.assertTrue(broker.arm_deadline(directory, EXECUTION_ID))
        self.assertEqual(sum(call[0][0] == "/usr/bin/systemd-run" for call in self.calls), 1)
        arguments, options = next(call for call in self.calls if call[0][0] == "/usr/bin/systemd-run")
        self.assertEqual(arguments[:2], ["/usr/bin/systemd-run", "--unit=paws-agent-expiry-" + EXECUTION_ID])
        self.assertEqual(arguments[-3:], ["/opt/paws-runner/current/deploy/linux/runner-broker.py", "expire", EXECUTION_ID])
        self.assertIn("--timer-property=AccuracySec=1ms", arguments)
        self.assertEqual(options["timeout"], 4)

    def test_restart_reuses_only_matching_atomic_expiry_before_admission(self):
        command = json.loads(self.job.read_text())["command"]
        original_mark = broker.mark_once
        def interrupted(directory, name):
            if name == EXECUTION_ID:
                raise RuntimeError("Crash before admission")
            return original_mark(directory, name)
        broker.mark_once = interrupted
        try:
            with self.assertRaises(RuntimeError):
                broker.admit_once(EXECUTION_ID, command)
        finally:
            broker.mark_once = original_mark
        self.assertFalse((pathlib.Path(broker.RECEIPTS) / EXECUTION_ID).exists())
        with self.assertRaises(ValueError):
            broker.admit_once(EXECUTION_ID, {**command, "expiresAt": command["expiresAt"] + 1000})
        self.assertTrue(broker.admit_once(EXECUTION_ID, command))
        self.assertFalse(broker.admit_once(EXECUTION_ID, command))

    def test_invalid_expiry_never_admits_or_arms_a_worker(self):
        for expiry in (None, True, "123", -1, 9007199254740992, int(time.time() * 1000) - 1):
            with self.assertRaises(ValueError):
                broker.admit_once(EXECUTION_ID, {"type": "probe", "expiresAt": expiry})
        self.assertFalse((pathlib.Path(broker.RECEIPTS) / EXECUTION_ID).exists())
        self.assertEqual(self.calls, [])

    def test_crash_after_durable_receipt_never_starts_again(self):
        self.assertTrue(broker.admit_once(EXECUTION_ID, json.loads(self.job.read_text())["command"]))
        self.assertEqual(self.command(), {"ok": True, "alreadyAdmitted": True})
        self.assertEqual(self.calls, [])

    def test_stop_fences_late_start_and_waits_for_backend(self):
        self.delay = 0.1
        result = self.request(json.dumps({"operation": "stop", "executionId": EXECUTION_ID}).encode() + b"\n")
        self.assertEqual(result["response"], {"ok": True})
        self.assertGreaterEqual(result["elapsed"], 0.09)
        self.assertEqual(self.command(), {"ok": True, "alreadyAdmitted": True})
        self.assertEqual(self.command("stop"), {"ok": True})
        self.assertEqual([call[0][1] for call in self.calls], ["kill", "stop", "show", "kill", "stop", "show"])

    def test_rejects_extra_fields_bad_operations_and_paths(self):
        for request in ({"operation": "start", "executionId": "../../sshd"}, {"operation": "restart", "executionId": EXECUTION_ID}, {"operation": "start", "executionId": EXECUTION_ID, "command": "arbitrary"}, {"operation": "start", "executionId": None}, []):
            with self.subTest(request=request):
                self.assertEqual(self.request(json.dumps(request).encode() + b"\n")["response"], {"ok": False})
        self.assertEqual(self.calls, [])

    def test_rejects_malformed_oversized_and_multiple_frames(self):
        for payload in (b"invalid\n", b"x" * 1025 + b"\n", b"{}\n{}\n", b"{}"):
            with self.subTest(length=len(payload)):
                self.assertEqual(self.request(payload)["response"], {"ok": False})
        self.assertEqual(self.calls, [])

    def test_deep_job_json_is_rejected_and_stop_remains_available(self):
        self.job.write_text("[" * 2000 + "0" + "]" * 2000)
        self.assertEqual(self.command(), {"ok": False})
        self.assertEqual(self.command("stop"), {"ok": True})
        self.assertEqual([call[0][1] for call in self.calls], ["kill", "stop", "show"])

    def test_rejects_symlink_hardlink_and_writable_job(self):
        content = self.job.read_bytes()
        self.job.chmod(0o660)
        self.assertEqual(self.command(), {"ok": False})
        self.job.chmod(0o640)
        os.link(self.job, self.root / "hardlink")
        self.assertEqual(self.command(), {"ok": False})
        (self.root / "hardlink").unlink()
        self.job.unlink()
        (self.root / "replacement").write_bytes(content)
        self.job.symlink_to(self.root / "replacement")
        self.assertEqual(self.command(), {"ok": False})
        self.assertEqual(self.calls, [])

    def test_rejects_symlink_job_directory_and_spool_root(self):
        moved = self.root / "moved"
        self.directory.rename(moved)
        self.directory.symlink_to(moved, target_is_directory=True)
        self.assertEqual(self.command(), {"ok": False})
        self.directory.unlink()
        moved.rename(self.directory)
        actual = self.root / "actual-spool"
        pathlib.Path(broker.SPOOL).rename(actual)
        pathlib.Path(broker.SPOOL).symlink_to(actual, target_is_directory=True)
        self.assertEqual(self.command(), {"ok": False})
        self.assertEqual(self.calls, [])

    def test_rejects_writable_or_symlink_unit(self):
        unit = pathlib.Path(broker.UNIT)
        unit.chmod(0o666)
        self.assertEqual(self.command(), {"ok": False})
        unit.unlink()
        unit.symlink_to(self.job)
        self.assertEqual(self.command(), {"ok": False})
        self.assertEqual(self.calls, [])

    def test_rejects_symlink_receipt_and_results_root(self):
        receipt = pathlib.Path(broker.RECEIPTS) / EXECUTION_ID
        receipt.symlink_to(self.job)
        self.assertEqual(self.command(), {"ok": False})
        receipt.unlink()
        actual = self.root / "actual-results"
        pathlib.Path(broker.RESULTS).rename(actual)
        pathlib.Path(broker.RESULTS).symlink_to(actual, target_is_directory=True)
        self.assertEqual(self.command(), {"ok": False})
        self.assertEqual(self.calls, [])

    @unittest.skipUnless(len(sys.argv) > 3, "Compiled production spool probe required")
    def test_production_spool_and_result_apis_between_real_uids(self):
        shutil.rmtree(self.directory)
        def run(mode, uid):
            def credentials():
                os.setgroups([1002, 1003])
                os.setgid(uid)
                os.setuid(uid)
            result = self.original_run([sys.argv[3], "--no-env-file", sys.argv[2], mode, str(self.root)], preexec_fn=credentials, env={"PATH": "/usr/bin:/bin", "HOME": str(self.root)}, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertEqual(run("publish", 1001), {"published": True})
        self.assertEqual(run("read", 1002), {"read": True, "publishDenied": True})
        self.assertEqual(self.command(), {"ok": True, "alreadyAdmitted": False})
        self.assertEqual(run("result", 1002), {"written": True})
        self.assertEqual(run("verify", 1001), {"result": "synthetic result", "symlinkDenied": True})

    @unittest.skipUnless(len(sys.argv) > 4, "Compiled production answer probe required")
    def test_production_answer_publish_read_and_write_denial_between_real_uids(self):
        shutil.rmtree(self.directory)
        def run(arguments, uid):
            def credentials():
                os.setgroups([1002, 1003])
                os.setgid(uid)
                os.setuid(uid)
            result = self.original_run(arguments, preexec_fn=credentials, env={"PATH": "/usr/bin:/bin", "HOME": str(self.root)}, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertEqual(run([sys.argv[3], "--no-env-file", sys.argv[2], "publish", str(self.root)], 1001), {"published": True})
        request_id = "7fb5a160-a1be-4b30-8e9b-cc19dc6f62e3"
        def answer(mode, uid):
            return run([sys.argv[4], mode, broker.SPOOL, EXECUTION_ID, "1001", "1002", request_id], uid)
        self.assertEqual(answer("publish", 1001), {"published": True})
        self.assertEqual(answer("read", 1002), {"read": True})
        self.assertEqual(answer("deny", 1002), {"writeDenied": True})


if __name__ == "__main__":
    print(json.dumps({"pythonVersion": sys.version.split()[0]}), flush=True)
    unittest.main(argv=sys.argv[:1], verbosity=2)
