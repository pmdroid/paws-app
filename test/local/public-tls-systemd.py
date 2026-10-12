import json
import hashlib
import sys
import os
import pathlib
import pwd
import subprocess
import time

assert os.geteuid() == 0
assert pathlib.Path('/proc/1/comm').read_text().strip() == 'systemd'
assert len(sys.argv) == 2
product = pathlib.Path(sys.argv[1]).read_text()
assert 'ExecReload=/opt/paws/bin/bun --no-env-file /opt/paws/current/src/index.ts public-tls validate\nExecReload=/bin/kill -HUP $MAINPID\n' in product
policy = ['Restart=on-failure', 'RestartSec=5', 'KillMode=control-group', 'TimeoutStopSec=30', 'UMask=0077', 'NoNewPrivileges=true']
assert all(line in product.splitlines() for line in policy)
root = pathlib.Path('/opt/paws-tls-policy-proof')
root.mkdir(mode=0o755)
def run(*args, check=True):
    return subprocess.run(args, capture_output=True, text=True, check=check)
run('/usr/bin/systemd-sysusers', '--inline', 'u paws-tls-proof - Paws-TLS-proof /var/lib/paws-tls-proof /usr/sbin/nologin')
state = pathlib.Path('/var/lib/paws-tls-proof')
state.mkdir(mode=0o700)
user = pwd.getpwnam('paws-tls-proof')
os.chown(state, user.pw_uid, user.pw_gid)
(root / 'valid').write_text('no')
(root / 'validate.py').write_text("import pathlib,sys\nsys.exit(0 if pathlib.Path('/opt/paws-tls-policy-proof/valid').read_text()=='yes' else 1)\n")
(root / 'main.py').write_text("import os,pathlib,signal,sys,time\ndef reload(signal_number,frame):\n    pathlib.Path('/var/lib/paws-tls-proof/joined').write_text(str(os.getpid()))\n    sys.exit(75)\nsignal.signal(signal.SIGHUP,reload)\nsignal.signal(signal.SIGTERM,lambda signal_number,frame:sys.exit(0))\nwhile True:time.sleep(.1)\n")
unit='''[Unit]
Description=Paws TLS restart policy proof
[Service]
Type=exec
User=paws-tls-proof
Group=paws-tls-proof
ExecStart=/usr/bin/python3 -I -B /opt/paws-tls-policy-proof/main.py
ExecReload=/usr/bin/python3 -I -B /opt/paws-tls-policy-proof/validate.py
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
'''
pathlib.Path('/etc/systemd/system/paws-tls-policy-proof.service').write_text(unit)
run('/usr/bin/systemctl','daemon-reload')
run('/usr/bin/systemctl','start','paws-tls-policy-proof.service')
def status():
    text=run('/usr/bin/systemctl','show','paws-tls-policy-proof.service','--property=MainPID,ActiveState,SubState,NRestarts').stdout
    return dict(line.split('=',1) for line in text.splitlines())
old=status()
assert old['ActiveState']=='active' and int(old['MainPID'])>0,old
time.sleep(.2)
invalid=run('/usr/bin/systemctl','reload','paws-tls-policy-proof.service',check=False)
time.sleep(.2)
retained=status()
assert invalid.returncode!=0 and retained['MainPID']==old['MainPID'] and retained['ActiveState']=='active',retained
assert not (state/'joined').exists()
(root/'valid').write_text('yes')
valid=run('/usr/bin/systemctl','reload','paws-tls-policy-proof.service',check=False)
assert valid.returncode==0,valid.stderr
end=time.monotonic()+12
while time.monotonic()<end:
    new=status()
    if new['MainPID']!=old['MainPID'] and int(new['MainPID'])>0 and new['ActiveState']=='active':break
    time.sleep(.1)
else:raise AssertionError(new)
assert (state/'joined').read_text()==old['MainPID']
assert int(new['NRestarts'])==1,new
uid=next(line for line in pathlib.Path('/proc/'+new['MainPID']+'/status').read_text().splitlines() if line.startswith('Uid:')).split()[1]
assert int(uid)==user.pw_uid and int(uid)!=0
run('/usr/bin/systemctl','stop','paws-tls-policy-proof.service')
assert status()['MainPID']=='0'
print('PAWS_TLS_SYSTEMD_PROOF '+json.dumps({'passed':True,'pid1':pathlib.Path('/proc/1/comm').read_text().strip(),'invalidReloadExit':invalid.returncode,'invalidRetainedMainPid':retained['MainPID'],'restartExit':75,'newMainPid':new['MainPID'],'nRestarts':new['NRestarts'],'serviceUid':int(uid),'validationPreventsSignal':True,'cleanStopNoRestart':True,'productUnitSha256':hashlib.sha256(product.encode()).hexdigest(),'systemdVersion':run('/usr/bin/systemctl','--version').stdout.splitlines()[0]}),flush=True)
