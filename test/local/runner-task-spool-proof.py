import json
import os
import pathlib
import subprocess
import signal
import time

root = pathlib.Path('/proof/data')
root.mkdir(mode=0o755)
os.chown(root, 1001, 1001)
for name, mode, gid in [('spool', 0o2750, 1002), ('source', 0o700, 1001)]:
    path = root / name
    path.mkdir()
    os.chown(path, 1001, gid)
    os.chmod(path, mode)

def invoke(mode, uid, gid):
    def identity():
        os.setgroups([1001, 1002] if uid == 1001 else [gid])
        os.setgid(gid)
        os.setuid(uid)
    result = subprocess.run(['/proof/bun', '--no-env-file', '/proof/probe.js', mode], preexec_fn=identity, capture_output=True, text=True, timeout=20, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'})
    if result.returncode != 0:
        raise RuntimeError(result.stdout + result.stderr)
    return json.loads(result.stdout)

published = invoke('publish', 1001, 1001)
atomic_source = root / 'atomic-source'
atomic_source.mkdir(mode=0o700)
os.chown(atomic_source, 1001, 1001)
large = atomic_source / 'large'
large.write_bytes(b'')
os.chown(large, 1001, 1001)
os.chmod(large, 0o644)
os.truncate(large, 67108864)
def daemon_identity():
    os.setgroups([1001, 1002])
    os.setgid(1001)
    os.setuid(1001)
publisher = subprocess.Popen(['/proof/bun', '--no-env-file', '/proof/probe.js', 'atomic'], preexec_fn=daemon_identity, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'})
partial = None
deadline = time.monotonic() + 10
while time.monotonic() < deadline and publisher.poll() is None:
    for stage in (root / 'spool').glob('.01K00000000000000000000003.*'):
        candidate = stage / 'repository' / 'large'
        try:
            if 0 < candidate.stat().st_size < 67108864:
                os.kill(publisher.pid, signal.SIGSTOP)
                partial = candidate
                break
        except FileNotFoundError:
            pass
    if partial:
        break
    time.sleep(0.0005)
if not partial:
    publisher.kill()
    publisher.wait()
    raise RuntimeError('Bounded in-flight copy was not observed')
try:
    _, status = os.waitpid(publisher.pid, os.WUNTRACED)
    assert os.WIFSTOPPED(status)
    paused_bytes = partial.stat().st_size
    assert 0 < paused_bytes < 67108864
    def agent_identity():
        os.setgroups([1002])
        os.setgid(1002)
        os.setuid(1002)
    result = subprocess.run(['/proof/bun', '--no-env-file', '/proof/probe.js', 'staging', str(partial)], preexec_fn=agent_identity, capture_output=True, text=True, timeout=10, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'})
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    in_flight = {**json.loads(result.stdout), "pausedBytes": paused_bytes, "completeBytes": 67108864}
finally:
    os.kill(publisher.pid, signal.SIGCONT)
stdout, stderr = publisher.communicate(timeout=20)
if publisher.returncode:
    raise RuntimeError(stdout + stderr)
assert json.loads(stdout)['published']

agent = invoke('agent', 1002, 1002)
outsider = invoke('outsider', 1004, 1004)
repository = root / 'spool' / '01K00000000000000000000001' / 'repository'
file = repository / 'nested' / 'source.txt'
os.chmod(file, 0o660)
unsafe_mode = invoke('tampered', 1001, 1001)
os.chmod(file, 0o640)
file.unlink()
file.symlink_to('/etc/passwd')
unsafe_link = invoke('tampered', 1001, 1001)
input_file = root / 'spool' / '01K00000000000000000000002' / 'input-0.bytes'
os.chmod(input_file, 0o660)
input_mode = invoke('input-tampered', 1001, 1001)
os.chmod(input_file, 0o640)
input_file.write_bytes(b'corrupt')
input_corrupt = invoke('input-tampered', 1001, 1001)
input_file.unlink()
input_file.symlink_to('/etc/passwd')
input_link = invoke('input-tampered', 1001, 1001)
print(json.dumps({'passed': True, 'runnerUid': 1001, 'agentUid': 1002, 'outsiderUid': 1004, 'published': published, 'inFlight': in_flight, 'agent': agent, 'outsider': outsider, 'unsafeMode': unsafe_mode, 'unsafeLink': unsafe_link, 'inputMode': input_mode, 'inputCorrupt': input_corrupt, 'inputLink': input_link}))
