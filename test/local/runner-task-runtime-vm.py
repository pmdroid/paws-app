import grp
import hashlib
import json
import os
import pathlib
import pwd
import signal
import sqlite3
import subprocess
import time


APP = pathlib.Path('/opt/paws-runner/current')
ASSETS = APP / 'deploy/linux'
BUN = '/opt/paws-runner/bin/bun'
ROOT = pathlib.Path('/var/lib/paws-task-proof')
HOME = pathlib.Path('/var/lib/paws-runner')


def run(*args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    assert result.returncode == 0, result.stdout + result.stderr
    return result


def main():
    assert os.getuid() == 0 and pathlib.Path('/proc/1/comm').read_text().strip() == 'systemd'
    run('/usr/bin/systemd-sysusers', str(ASSETS / 'paws-runner.sysusers'))
    run('/usr/bin/systemd-tmpfiles', '--create', str(ASSETS / 'paws-runner.tmpfiles'))
    runner = pwd.getpwnam('paws-runner')
    agent = pwd.getpwnam('paws-agent')
    result_gid = grp.getgrnam('paws-results').gr_gid
    ROOT.mkdir(mode=0o755)
    os.chown(HOME, 0, 0)
    run(BUN, '--no-env-file', str(APP / 'src/index.ts'), 'prepare')
    for path in (HOME, *HOME.rglob('*')):
        os.chown(path, runner.pw_uid, runner.pw_gid)
    for path in (ROOT / 'origin.git', *(ROOT / 'origin.git').rglob('*')):
        os.chown(path, runner.pw_uid, runner.pw_gid)
    runtime = HOME / 'runtime'
    runtime.mkdir(mode=0o700)
    os.chown(runtime, runner.pw_uid, runner.pw_gid)
    scripts = ROOT / 'scripts'
    scripts.mkdir(mode=0o755)
    os.chown(scripts, runner.pw_uid, runner.pw_gid)
    for name in ('paws-agent@.service', 'paws-runner-broker.service', 'paws-runner-broker.socket'):
        (pathlib.Path('/etc/systemd/system') / name).write_bytes((ASSETS / name).read_bytes())
    (APP / 'node_modules/.bin').mkdir(parents=True)
    launcher = APP / 'node_modules/.bin/claude-agent-acp'
    launcher.write_text('#!/opt/paws-runner/bin/bun\nprocess.argv.splice(2,0,"agent");await import("../../src/index.ts");\n')
    launcher.chmod(0o755)
    run('/usr/bin/systemctl', 'daemon-reload')
    run('/usr/bin/systemctl', 'start', 'paws-runner-broker.socket')
    logs = []
    actors = []
    def actor(mode, daemon=False):
        log = open(ROOT / (mode + '.log'), 'wb')
        logs.append(log)
        def identity():
            os.setgroups([agent.pw_gid, result_gid])
            os.setgid(runner.pw_gid)
            os.setuid(runner.pw_uid)
        process = subprocess.Popen([BUN, '--no-env-file', str(APP / 'src/index.ts'), mode, str(runner.pw_uid), str(agent.pw_gid), str(agent.pw_uid), str(result_gid)], stdout=log, stderr=log, env={'PATH':'/usr/bin:/bin','HOME':str(HOME)}, preexec_fn=identity if daemon else None)
        actors.append(process)
        return process
    try:
        coordinator = actor('coordinator')
        deadline = time.monotonic() + 30
        while not (ROOT / 'server/ready').exists():
            assert coordinator.poll() is None and time.monotonic() < deadline
            time.sleep(0.05)
        daemon = actor('runtime', True)
        assert daemon.wait(timeout=240) == 0
        assert json.loads((runtime / 'done.json').read_text())['passed']
        coordinator.send_signal(signal.SIGTERM)
        assert coordinator.wait(timeout=15) == 0
        db = sqlite3.connect(ROOT / 'server/paws.db')
        results = [json.loads(row[0]) for row in db.execute('SELECT payload FROM runner_result ORDER BY rowid')]
        assert len(results) == 4 and all(row['role'] == 'implementer' and not set(row) & {'candidateSha','reviewText'} for row in results)
        kinds = [json.loads(row[0])['type'] for row in db.execute('SELECT payload FROM runner_event ORDER BY rowid')]
        assert kinds.count('question') == 4 and kinds.count('artifact') == 2
        assert db.execute('SELECT COUNT(*) FROM runner_question_answer').fetchone()[0] == 6
        sealed = db.execute('SELECT execution_id,sealed_size,sha256,uri FROM runner_transcript WHERE uri IS NOT NULL ORDER BY rowid').fetchall()
        assert len(sealed) == 4
        config = json.loads((ROOT / 'config.json').read_text())
        for index,(execution_id,size,digest,uri) in enumerate(sealed):
            raw = (pathlib.Path('/var/lib/paws-agent-results') / execution_id / 'events.jsonl').read_bytes()
            stored = (ROOT / 'server/objects' / uri.removeprefix('s3://task-fixture/')).read_bytes()
            assert stored == raw and len(raw) == size and hashlib.sha256(raw).hexdigest() == digest
            trace = json.loads((pathlib.Path('/var/lib/paws-agent-tasks') / execution_id / 'agent.json').read_text())
            assert config['commands'][index]['prompt'] in json.dumps(trace['prompts'])
            assert trace['askTeam']['text'] == 'Yes'
            if config['commands'][index]['purpose'] == 'artifact':
                assert trace['terminals'][0]['exitCode'] == 0
            else:
                assert not trace['terminals'][0]['ok']
            if config['commands'][index].get('repository'):
                assert trace['fs'][0]['content'] == 'authorized source' and not trace['fs'][1]['ok']
                assert (pathlib.Path('/var/lib/paws-runner-spool') / execution_id / 'repository/tracked').read_text() == 'authorized source'
            assert len(list(pathlib.Path('/var/lib/paws-runner-broker').glob(execution_id + '.launched'))) == 1
        db.close()
        journal = sqlite3.connect(runtime / 'executions.db')
        assert journal.execute("SELECT COUNT(*) FROM execution WHERE phase='complete' AND consumed=transcript_offset AND consumed>0").fetchone()[0] == 4
        journal.close()
        print('PAWS_TASK_RUNTIME_VM_PROOF ' + json.dumps({'passed':True,'pid1':True,'systemd':run('/usr/bin/systemctl','--version').stdout.splitlines()[0],'runnerUid':runner.pw_uid,'agentUid':agent.pw_uid,'taskResults':4,'questions':4,'artifacts':2,'sealedTranscripts':4,'canonicalOptionalRepositoryPinned':True,'kernelReadonlyRepository':True,'writeCredentials':0,'candidatePublications':0,'lostReceiptsRetriedWithoutDuplicateEffects':True,'relaunches':0}), flush=True)
    finally:
        for process in actors:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
        for log in logs:
            log.close()
        for path in ROOT.glob('*.log'):
            print(str(path) + '\n' + path.read_text(), flush=True)
        print(run('/usr/bin/journalctl','-u','paws-runner-broker.service','--no-pager').stdout, flush=True)
        print(run('/usr/bin/journalctl','-u','paws-agent@*.service','--no-pager','-n','100').stdout, flush=True)
        for path in pathlib.Path('/var/lib/paws-agent-results').glob('*/result.json'):
            print(str(path) + '\n' + path.read_text(), flush=True)


main()
