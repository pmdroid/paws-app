import os
import pathlib
import pwd
import grp
import runpy
import subprocess
import json
import hashlib
import sys
import tempfile
import time
import shutil

if os.geteuid() != 0 or not pathlib.Path('/.dockerenv').exists():
    raise RuntimeError('Run this proof in a disposable systemd container.')
if pathlib.Path('/var/lib/paws-runner-members').exists():
    raise RuntimeError('Use a fresh disposable container without Paws state.')
source = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix='paws-member-proof-', dir='/opt'))
os.chmod(root, 0o755)
for group in ['paws-agent', 'paws-runner', 'paws-results']:
    subprocess.run(['groupadd', '-f', group], check=True)
for user in ['paws-agent', 'paws-runner']:
    subprocess.run(['useradd', '-M', '-g', user, user], check=True)
agent = pwd.getpwnam('paws-agent')
runner = pwd.getpwnam('paws-runner')
results = grp.getgrnam('paws-results').gr_gid
for name, mode, uid, gid in [
    ('paws-runner-members', 0o700, 0, 0),
    ('paws-runner-spool', 0o2750, runner.pw_uid, agent.pw_gid),
    ('paws-agent-results', 0o750, 0, results),
    ('paws-agent-tasks', 0o755, 0, 0),
    ('paws-runner-broker', 0o700, 0, 0),
    ('paws-agent', 0o700, agent.pw_uid, agent.pw_gid),
]:
    path = pathlib.Path('/var/lib') / name
    path.mkdir(exist_ok=True)
    os.chown(path, uid, gid)
    os.chmod(path, mode)

installed = pathlib.Path('/opt/paws-runner/current/deploy/linux/runner-broker.py')
installed.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(source / 'deploy/linux/runner-broker.py', installed)
broker = runpy.run_path(str(installed))
template = (source / 'deploy/linux/paws-agent@.service').read_text()
template = '\n'.join(line for line in template.splitlines() if not line.startswith('ExecStart='))
template += '\nExecStart=/usr/bin/python3 ' + str(root / 'worker.py') + ' %i\n'
pathlib.Path('/etc/systemd/system/paws-agent@.service').write_text(template)

for execution in ['01J0000000000000000000000A', '01J0000000000000000000000B', '01J0000000000000000000000C', '01J0000000000000000000000D']:
    spool = pathlib.Path('/var/lib/paws-runner-spool') / execution
    spool.mkdir()
    os.chown(spool, runner.pw_uid, agent.pw_gid)
    os.chmod(spool, 0o2750)
    data = spool / 'command'
    data.write_text(execution)
    os.chown(data, runner.pw_uid, agent.pw_gid)
    os.chmod(data, 0o640)
    output = pathlib.Path('/var/lib/paws-agent-results') / execution
    output.mkdir()
    os.chown(output, agent.pw_uid, results)
    os.chmod(output, 0o2750)
    task = pathlib.Path('/var/lib/paws-agent-tasks') / execution
    task.mkdir()
    os.chown(task, agent.pw_uid, results)
    os.chmod(task, 0o700)
    (task / 'private-input').write_text(execution)
    os.chown(task / 'private-input', agent.pw_uid, results)
    command = {'workspaceId': 'workspace', 'memberId': execution, 'expiresAt': int(time.time() * 1000) + 120000}
    assert broker['admit_once'](execution, command)
    broker['prepare_member'](execution, command, agent.pw_uid, agent.pw_gid, runner.pw_uid, results)
    identity = hashlib.sha256(json.dumps(['workspace', execution], separators=(',', ':')).encode()).hexdigest()
    provider = pathlib.Path('/var/lib/paws-runner-members', identity, '.codex')
    if execution.endswith('A'):
        provider.mkdir(mode=0o755)
        os.chown(provider, agent.pw_uid, agent.pw_gid)
        (provider / 'existing').write_text('synthetic-preserved-login')
        os.chown(provider / 'existing', agent.pw_uid, agent.pw_gid)
        os.chmod(provider / 'existing', 0o600)
    elif execution.endswith('C'):
        provider.symlink_to(root)
    elif execution.endswith('D'):
        provider.mkdir(mode=0o755)

worker = '''import os,pathlib,json,time,sys
execution=sys.argv[1]
home=pathlib.Path('/var/lib/paws-agent')
home.joinpath('credential').write_text(execution+'-synthetic-credential')
result={'execution':execution,'pid':os.getpid(),'uidMap':pathlib.Path('/proc/self/uid_map').read_text(),'gidMap':pathlib.Path('/proc/self/gid_map').read_text(),'ownInput':pathlib.Path('/var/lib/paws-runner-spool',execution,'command').read_text(),'ownCredential':home.joinpath('credential').read_text(),'ownTask':pathlib.Path('/var/lib/paws-agent-tasks',execution,'private-input').read_text(),'privileges':{line.split(':')[0]:line.split(':')[1].strip() for line in pathlib.Path('/proc/self/status').read_text().splitlines() if line.startswith(('CapInh:','CapPrm:','CapEff:','CapBnd:','CapAmb:','NoNewPrivs:'))}}
result['procReadOnly']=bool(os.statvfs('/proc').f_flag & os.ST_RDONLY)
result['providerHomes']={name:{'uid':home.joinpath(name).stat().st_uid,'mode':home.joinpath(name).stat().st_mode & 0o777} for name in ['.codex','.claude']}
if execution.endswith('A'): result['existingLoginPreserved']=home.joinpath('.codex','existing').read_text()=='synthetic-preserved-login'
if execution=='01J0000000000000000000000B':
 for key,path in [('memberParent','/var/lib/paws-runner-members'),('peerSpool','/var/lib/paws-runner-spool/01J0000000000000000000000A/command'),('peerResult','/var/lib/paws-agent-results/01J0000000000000000000000A/result.json'),('peerTask','/var/lib/paws-agent-tasks/01J0000000000000000000000A/private-input')]:
  try:
   pathlib.Path(path).read_bytes() if key!='memberParent' else list(pathlib.Path(path).iterdir())
   result[key]='ACCESSIBLE'
  except OSError as error: result[key]=error.errno
 pid=int(pathlib.Path(__file__).with_name('victim-pid').read_text())
 for name,suffix in [('peerRoot','root/var/lib/paws-agent/credential'),('peerMemory','mem'),('peerEnvironment','environ')]:
  try:
   pathlib.Path('/proc',str(pid),suffix).read_bytes()
   result[name]='ACCESSIBLE'
  except OSError as error: result[name]=error.errno
 try:
  os.kill(pid,0)
  result['peerSignal']='ACCESSIBLE'
 except OSError as error: result['peerSignal']=error.errno
path=pathlib.Path('/var/lib/paws-agent-results',execution,'result.json')
path.write_text(json.dumps(result))
os.chown(path,os.getuid(),os.getgid())
if execution=='01J0000000000000000000000A': time.sleep(120)
'''
(root / 'worker.py').write_text(worker)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'start', 'paws-agent@01J0000000000000000000000A.service'], check=True)
victim = subprocess.check_output(['systemctl', 'show', '-p', 'MainPID', '--value', 'paws-agent@01J0000000000000000000000A.service'], text=True).strip()
(root / 'victim-pid').write_text(victim)
subprocess.run(['systemctl', 'start', 'paws-agent@01J0000000000000000000000B.service'], check=True)
for n in range(100):
    result_file = pathlib.Path('/var/lib/paws-agent-results/01J0000000000000000000000B/result.json')
    if result_file.exists():
        break
    time.sleep(0.1)
result = json.loads(result_file.read_text())
assert result['pid'] == 1, result
assert result['procReadOnly'], result
assert all(value['uid'] == agent.pw_uid and value['mode'] == 0o700 for value in result['providerHomes'].values()), result
assert result['privileges']['NoNewPrivs'] == '1', result
assert all(int(result['privileges'][name], 16) == 0 for name in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']), result
for key in ['memberParent', 'peerSpool', 'peerResult', 'peerTask', 'peerRoot', 'peerMemory', 'peerEnvironment', 'peerSignal']:
    assert result[key] in [2, 3, 13], result
assert result['ownInput'] == '01J0000000000000000000000B', result
assert result['ownCredential'] == '01J0000000000000000000000B-synthetic-credential', result
assert result['ownTask'] == '01J0000000000000000000000B', result
identity = hashlib.sha256(json.dumps(['workspace', '01J0000000000000000000000A'], separators=(',', ':')).encode()).hexdigest()
assert pathlib.Path('/var/lib/paws-runner-members', identity, 'credential').read_text() == '01J0000000000000000000000A-synthetic-credential'
first = json.loads(pathlib.Path('/var/lib/paws-agent-results/01J0000000000000000000000A/result.json').read_text())
assert first['existingLoginPreserved'], first
assert all(value['uid'] == agent.pw_uid and value['mode'] == 0o700 for value in first['providerHomes'].values()), first
for execution in ['01J0000000000000000000000C', '01J0000000000000000000000D']:
    unit = 'paws-agent@' + execution + '.service'
    subprocess.run(['systemctl', 'start', unit], check=True)
    for attempt in range(100):
        status = subprocess.check_output(['systemctl', 'show', '-p', 'ExecMainStatus', '--value', unit], text=True).strip()
        if status == '1':
            break
        time.sleep(0.05)
    assert status == '1', status
    assert not pathlib.Path('/var/lib/paws-agent-results', execution, 'result.json').exists()
    subprocess.run(['systemctl', 'stop', unit], check=True)
for execution in ['01J0000000000000000000000A', '01J0000000000000000000000B']:
    identity = hashlib.sha256(json.dumps(['workspace', execution], separators=(',', ':')).encode()).hexdigest()
    assert pathlib.Path('/var/lib/paws-runner-members', identity, 'credential').read_text() == execution + '-synthetic-credential'
    assert pathlib.Path('/var/lib/paws-runner-broker', execution + '.launched').is_file()
    subprocess.run(['systemctl', 'is-active', '--quiet', 'paws-agent-expiry-' + execution + '.timer'], check=True)
assert not pathlib.Path('/var/lib/paws-agent/credential').exists()
privileges = subprocess.check_output(['/usr/bin/setpriv', '--bounding-set=-all', '--no-new-privs', '/usr/bin/python3', '-c', 'print(open("/proc/self/status").read())'], text=True)
privileges = {line.split(':')[0]: line.split(':')[1].strip() for line in privileges.splitlines() if line.startswith(('CapEff:', 'CapBnd:', 'NoNewPrivs:'))}
assert int(privileges['CapEff'], 16) == int(privileges['CapBnd'], 16) == 0 and privileges['NoNewPrivs'] == '1', privileges
print(json.dumps({'passed': True, 'guardPrivileges': privileges, 'observed': result, 'existingLoginPreserved': first['existingLoginPreserved'], 'unsafeProviderHomesRejected': 2}))
subprocess.run(['systemctl', 'stop', 'paws-agent@01J0000000000000000000000A.service'], check=True)
