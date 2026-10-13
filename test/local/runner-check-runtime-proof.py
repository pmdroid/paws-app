import grp
import json
import os
import pathlib
import pwd
import signal
import sqlite3
import subprocess
import time


root = pathlib.Path('/var/lib/paws-proof')
assets = pathlib.Path('/opt/paws-runner/current/deploy/linux')


def run(*arguments):
    return subprocess.run(arguments, capture_output=True, text=True, check=True)


def wait(predicate, process=None):
    deadline = time.monotonic() + 120
    while not predicate():
        assert time.monotonic() < deadline, 'Runtime proof timeout'
        assert process is None or process.poll() is None, 'Runtime process exited early'
        time.sleep(0.05)


def main():
    assert os.getuid() == 0 and pathlib.Path('/proc/1/comm').read_text().strip() == 'systemd'
    run('/usr/bin/systemd-sysusers', str(assets / 'paws-runner.sysusers'))
    run('/usr/bin/systemd-tmpfiles', '--create', str(assets / 'paws-runner.tmpfiles'))
    runner = pwd.getpwnam('paws-runner')
    check = pwd.getpwnam('paws-check')
    input_gid = grp.getgrnam('paws-check-input').gr_gid
    for name in ('paws-agent@.service', 'paws-runner-broker.service', 'paws-runner-broker.socket', 'paws-check@.service', 'paws-check-witness@.service'):
        (pathlib.Path('/etc/systemd/system') / name).write_bytes((assets / name).read_bytes())
    identity = json.loads(run('/usr/bin/python3', '-I', '-B', str(assets / 'check-verifier.py'), 'initialize').stdout)
    run('/usr/bin/systemctl', 'daemon-reload')
    run('/usr/bin/systemctl', 'start', 'paws-runner-broker.socket')
    root.mkdir(mode=0o755)
    os.chown(root, 2001, 2001)
    for name, uid, gid, mode in (('server', 2001, 2001, 0o700), ('daemon', runner.pw_uid, runner.pw_gid, 0o700), ('runtime', runner.pw_uid, runner.pw_gid, 0o700), ('repositories', runner.pw_uid, runner.pw_gid, 0o700), ('ipc', runner.pw_uid, runner.pw_gid, 0o755)):
        path = root / name
        path.mkdir(mode=mode)
        os.chown(path, uid, gid)
    source = pathlib.Path('/root/source')
    source.mkdir()
    run('/usr/bin/git', 'init', '-b', 'main', str(source))
    run('/usr/bin/git', '-C', str(source), 'config', 'user.email', 'fixture@localhost')
    run('/usr/bin/git', '-C', str(source), 'config', 'user.name', 'Fixture')
    (source / '.gitignore').write_text('.paws-deps/\n')
    (source / 'tracked').write_text('original\n')
    run('/usr/bin/git', '-C', str(source), 'add', '.')
    run('/usr/bin/git', '-C', str(source), 'commit', '-m', 'Fixture')
    candidate = run('/usr/bin/git', '-C', str(source), 'rev-parse', 'HEAD').stdout.strip()
    run('/usr/bin/git', '-C', str(source), 'bundle', 'create', str(root / 'repository.bundle'), '--all')
    (root / 'repository.bundle').chmod(0o444)
    (root / 'initial.json').write_text(json.dumps({'runnerUid': runner.pw_uid, 'runnerGid': runner.pw_gid, 'checkUid': check.pw_uid, 'checkGid': check.pw_gid, 'inputGid': input_gid, 'candidate': candidate, 'verifierPublicKeyPem': identity['verifierPublicKeyPem']}))
    print('PAWS_CHECK_RUNTIME_STAGE source-ready', flush=True)
    logs = []
    actors = []
    def actor(mode, uid):
        log = open('/root/' + mode + '.log', 'wb')
        logs.append(log)
        daemon = uid == runner.pw_uid
        process = subprocess.Popen(['/opt/paws-runner/bin/bun', '--no-env-file', '/opt/paws-runner/runtime-proof.js', mode], stdout=log, stderr=log, env={'HOME': str(root / ('daemon' if daemon else 'server')), 'PATH': '/usr/bin:/bin'}, user=uid, group=runner.pw_gid if daemon else uid, extra_groups=[input_gid] if daemon else [], start_new_session=True)
        actors.append(process)
        return process
    def kill(process):
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
    def commands():
        return json.loads((root / 'commands.json').read_text())
    def held(execution):
        try:
            job = json.loads((pathlib.Path('/var/lib/paws-check-input/commands') / execution / 'job.json').read_text())
        except FileNotFoundError:
            return False
        return (pathlib.Path(job['env']['HOME']) / 'held').exists()
    def inactive(execution):
        for template in ('paws-check@', 'paws-check-witness@'):
            state = run('/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', template + execution).stdout.strip()
            if state not in ('inactive', 'failed'):
                return False
        return True
    try:
        print('PAWS_CHECK_RUNTIME_STAGE coordinator-start', flush=True)
        coordinator = actor('coordinator', 2001)
        wait(lambda: (root / 'config.json').exists(), coordinator)
        pair = actor('pair', runner.pw_uid)
        assert pair.wait(timeout=120) == 0
        print('PAWS_CHECK_RUNTIME_STAGE paired', flush=True)
        wait(lambda: (root / 'server/ready').exists(), coordinator)
        first = actor('first', runner.pw_uid)
        wait(lambda: (root / 'ipc/lost-ready').exists(), first)
        assert all(json.loads((root / 'ipc/transient-retries.json').read_text()).values())
        wait(lambda: (root / 'server/lost.json').exists(), first)
        assert json.loads((root / 'server/lost.json').read_text())['second'] == commands()[1]
        print('PAWS_CHECK_RUNTIME_STAGE lost-receipt', flush=True)
        kill(first)
        second = actor('second', runner.pw_uid)
        wait(lambda: len(commands()) == 3 and held(commands()[2]), second)
        lease_execution = commands()[2]
        (root / 'outage').write_text('outage')
        wait(lambda: (root / 'ipc/lease-stopped').exists(), second)
        assert inactive(lease_execution)
        print('PAWS_CHECK_RUNTIME_STAGE lease-stopped', flush=True)
        kill(second)
        (root / 'outage').unlink()
        (root / 'next-four').write_text('next')
        wait(lambda: len(commands()) == 4, coordinator)
        third = actor('third', runner.pw_uid)
        wait(lambda: held(commands()[3]), third)
        crash_execution = commands()[3]
        assert not inactive(crash_execution)
        kill(third)
        assert not inactive(crash_execution)
        recovered = actor('recover', runner.pw_uid)
        assert recovered.wait(timeout=120) == 0
        assert inactive(crash_execution)
        print('PAWS_CHECK_RUNTIME_STAGE recovered', flush=True)
        assert (root / 'ipc/recovered.json').exists()
        coordinator.send_signal(signal.SIGTERM)
        assert coordinator.wait(timeout=30) == 0
        db = sqlite3.connect(root / 'runtime/checks.db')
        assert db.execute('SELECT phase FROM check_execution ORDER BY rowid').fetchall() == [('complete',), ('complete',), ('interrupted',), ('interrupted',)]
        db.close()
        summary = json.loads((root / 'server/summary.json').read_text())
        assert len(set(summary['commands'])) == 4
        summary['receipts'] = [{'result': json.loads((pathlib.Path('/var/lib/paws-check-results') / execution / 'result.json').read_text()), 'signature': (pathlib.Path('/var/lib/paws-check-results') / execution / 'verifier-signature').read_text()} for execution in summary['commands'][:2]]
        summary.update({'passed': True, 'network': 'none', 'runnerUid': runner.pw_uid, 'checkUid': check.pw_uid, 'lostReceiptReopen': True, 'transientGrantCredentialCloneRecovery': True, 'preservedDependencies': True, 'hungHeartbeatStopsActualPid1Check': True, 'crashRecoveryStopsWitnessAndChild': True, 'relaunches': 0, 'identity': identity})
        print('PAWS_CHECK_RUNTIME_PROOF ' + json.dumps(summary), flush=True)
    finally:
        journal = root / 'runtime/checks.db'
        if journal.exists():
            db = sqlite3.connect(journal)
            print('CHECK_PHASES ' + json.dumps(db.execute('SELECT id,phase FROM check_execution').fetchall()), flush=True)
            db.close()
        for process in actors:
            if process.poll() is None:
                kill(process)
        for log in logs:
            log.close()
        for path in pathlib.Path('/root').glob('*.log'):
            print(path.name + ': ' + path.read_text(errors='replace')[-12000:], flush=True)
        print(run('/usr/bin/journalctl', '-u', 'paws-runner-broker', '--no-pager').stdout[-12000:], flush=True)


if __name__ == '__main__':
    main()
