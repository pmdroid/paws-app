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

if os.geteuid() != 0 or pathlib.Path('/proc/1/comm').read_text().strip() != 'systemd':
    raise RuntimeError('Run this proof in a disposable systemd container.')
if pathlib.Path('/var/lib/paws-runner-members').exists():
    raise RuntimeError('Use a fresh disposable container without Paws state.')
source = pathlib.Path(sys.argv[1]).resolve()
assets = pathlib.Path('/opt/paws-runner/current/deploy/linux')
assets.mkdir(parents=True)
for name in ['runner-broker.py', 'check-broker.py']:
    shutil.copyfile(source / 'deploy/linux' / name, assets / name)
for name in ['paws-runner.sysusers', 'paws-runner.tmpfiles']:
    subprocess.run(['/usr/bin/systemd-' + ('sysusers' if name.endswith('sysusers') else 'tmpfiles'), *([] if name.endswith('sysusers') else ['--create']), str(source / 'deploy/linux' / name)], check=True)
agent = pwd.getpwnam('paws-agent')
runner = pwd.getpwnam('paws-runner')
results = grp.getgrnam('paws-results').gr_gid
broker = runpy.run_path(str(assets / 'runner-broker.py'))
root = pathlib.Path(tempfile.mkdtemp(prefix='paws-user-proof-', dir='/opt'))
os.chmod(root, 0o755)
cache = root / 'host-cache'
cache.mkdir(mode=0o700)
os.chown(cache, agent.pw_uid, agent.pw_gid)
worker = root / 'worker.py'
worker.write_text("""import json,os,pathlib,sys,time
execution=sys.argv[1]
home=pathlib.Path(os.environ['HOME'])
for provider in ['.codex','.claude']:home.joinpath(provider).mkdir(mode=0o700,exist_ok=True)
home.joinpath('credential').write_text(execution+'-synthetic-credential')
cache=pathlib.Path(sys.argv[2]);cache.joinpath(execution).write_text('host-access')
result={'execution':execution,'pid':os.getpid(),'uid':os.getuid(),'gid':os.getgid(),'home':str(home),'mountNamespace':os.readlink('/proc/self/ns/mnt'),'hostFile':cache.joinpath(execution).read_text(),'ownInput':pathlib.Path('/var/lib/paws-runner-spool',execution,'command').read_text(),'credential':home.joinpath('credential').read_text()}
path=pathlib.Path('/var/lib/paws-agent-results',execution,'result.json');path.write_text(json.dumps(result))
time.sleep(10)
""")
template = (source / 'deploy/linux/paws-agent@.service').read_text()
template = '\n'.join(line for line in template.splitlines() if not line.startswith('ExecStart='))
template += '\nExecStart=/usr/bin/python3 ' + str(worker) + ' %i ' + str(cache) + '\n'
pathlib.Path('/etc/systemd/system/paws-agent@.service').write_text(template)
executions = ['01J0000000000000000000000A', '01J0000000000000000000000B']
for execution in executions:
    spool=pathlib.Path('/var/lib/paws-runner-spool',execution);spool.mkdir(mode=0o750);os.chown(spool,runner.pw_uid,agent.pw_gid)
    command=spool/'command';command.write_text(execution);command.chmod(0o640);os.chown(command,runner.pw_uid,agent.pw_gid)
    broker['prepare_results'](execution,agent.pw_uid,results)
    command={'workspaceId':'workspace','memberId':execution,'expiresAt':int(time.time()*1000)+120000}
    assert broker['admit_once'](execution,command)
    broker['prepare_member'](execution,command,agent.pw_uid,agent.pw_gid,runner.pw_uid,results)
subprocess.run(['systemctl','daemon-reload'],check=True)
units=['paws-agent@'+execution+'.service' for execution in executions]
try:
    subprocess.run(['systemctl','start',*units],check=True)
    observed=[]
    for execution in executions:
        output=pathlib.Path('/var/lib/paws-agent-results',execution,'result.json')
        for attempt in range(100):
            if output.exists():break
            time.sleep(0.05)
        result=json.loads(output.read_text())
        identity=hashlib.sha256(json.dumps(['workspace',execution],separators=(',',':')).encode()).hexdigest()
        assert result['uid']==agent.pw_uid>0 and result['gid']==results and result['pid']>1,result
        assert result['mountNamespace']==os.readlink('/proc/self/ns/mnt'),result
        assert result['home']=='/var/lib/paws-runner-members/'+identity,result
        assert result['hostFile']=='host-access' and result['ownInput']==execution,result
        assert result['credential']==execution+'-synthetic-credential',result
        observed.append(result)
    assert observed[0]['home']!=observed[1]['home']
    for unit in units:subprocess.run(['systemctl','is-active','--quiet',unit],check=True)
    print(json.dumps({'passed':True,'nonRootUid':agent.pw_uid,'normalHostNamespace':True,'parallelServices':2,'distinctMemberHomes':True,'observed':observed}))
finally:
    subprocess.run(['systemctl','stop',*units],check=True)
