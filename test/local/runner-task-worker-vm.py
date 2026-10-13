import grp
import json
import os
import pathlib
import pwd
import socket
import subprocess
import time


ASSETS = pathlib.Path('/opt/paws-runner/current/deploy/linux')
APP = pathlib.Path('/opt/paws-runner/current')
BUN = '/opt/paws-runner/bin/bun'
WORK = pathlib.Path('/var/lib/paws-agent-tasks')


def run(*args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, check=True, **kwargs)


def main():
    assert os.getuid() == 0 and pathlib.Path('/proc/1/comm').read_text().strip() == 'systemd'
    run('/usr/bin/systemd-sysusers', str(ASSETS/'paws-runner.sysusers'))
    run('/usr/bin/systemd-tmpfiles', '--create', str(ASSETS/'paws-runner.tmpfiles'))
    runner = pwd.getpwnam('paws-runner')
    agent = pwd.getpwnam('paws-agent')
    results_gid = grp.getgrnam('paws-results').gr_gid
    assert runner.pw_uid != agent.pw_uid and WORK.stat().st_uid == 0 and WORK.stat().st_mode & 0o777 == 0o755
    for name in ('paws-agent@.service', 'paws-runner-broker.service', 'paws-runner-broker.socket'):
        (pathlib.Path('/etc/systemd/system')/name).write_bytes((ASSETS/name).read_bytes())
    (APP/'node_modules/.bin').mkdir(parents=True)
    launcher = APP/'node_modules/.bin/claude-agent-acp'
    launcher.write_text('#!/opt/paws-runner/bin/bun\nprocess.argv.splice(2,0,"agent");await import("../../src/index.ts");\n')
    launcher.chmod(0o755)
    (APP/'scripts').mkdir()
    root = pathlib.Path('/var/lib/paws-task-proof-input');root.mkdir(mode=0o755)
    def daemon():
        os.setgroups([agent.pw_gid, results_gid])
        os.setgid(runner.pw_gid)
        os.setuid(runner.pw_uid)
    client = "import json,socket,sys;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(50);s.connect('/run/paws-runner-broker.sock');s.sendall((json.dumps({'operation':sys.argv[1],'executionId':sys.argv[2]})+'\\n').encode());b=b''\nwhile not b.endswith(b'\\n'):b+=s.recv(1024)\nprint(b.decode(),end='')"
    def broker(operation, execution_id):
        return json.loads(run('/usr/bin/python3', '-c', client, operation, execution_id, preexec_fn=daemon).stdout)
    def command(execution_id, purpose, repository):
        now = int(time.time()*1000)
        value = {'id':'task-'+execution_id,'type':'task','runnerId':'runner','workspaceId':'workspace','runId':'run-'+execution_id,'itemId':'item','generation':1,'sessionId':'session','sessionGeneration':1,'taskModeGeneration':1,'purpose':purpose,'issuedAt':now,'expiresAt':now+120000,'profile':{'agent':'claude','model':'fixture-model'},'prompt':'Create a private report and return the requested '+purpose}
        if repository:value['repository']={'owner':'fixture','repo':'source','remoteUrl':'https://github.com/fixture/source.git','baseSha':'a'*40}
        return value
    def stage(execution_id, value, repository):
        job = root/(execution_id+'.json');job.write_text(json.dumps({'executionId':execution_id,'command':value}));job.chmod(0o644)
        args=[]
        if repository:
            source = root/execution_id;source.mkdir(mode=0o700);os.chown(source,runner.pw_uid,runner.pw_gid)
            (source/'tracked').write_text('source-original');os.chown(source/'tracked',runner.pw_uid,runner.pw_gid);(source/'tracked').chmod(0o600)
            args=[str(source)]
        run(BUN,'--no-env-file',str(APP/'src/index.ts'),'stage',str(agent.pw_gid),str(job),*args,preexec_fn=daemon,env={'PATH':'/usr/bin:/bin','HOME':'/var/lib/paws-runner'})
    run('/usr/bin/systemctl','daemon-reload')
    run('/usr/bin/systemctl','start','paws-runner-broker.socket')
    observed=[]
    for index,(purpose,repository) in enumerate((('answer',False),('artifact',False),('answer',True),('artifact',True)),1):
        execution_id='0'*25+str(index);value=command(execution_id,purpose,repository)
        stage(execution_id,value,repository)
        steps=[{'type':'permission','toolCall':{'toolCallId':'write-note','kind':'edit','locations':[{'path':str(WORK/execution_id/'note.txt')}]}},{'type':'fs_write','path':str(WORK/execution_id/'note.txt'),'content':'private'},{'type':'terminal','command':'sh','args':['-c','printf artifact > report.txt']}]
        if repository:
            steps += [{'type':'fs_read','path':str(WORK/execution_id/'repository/tracked')},{'type':'fs_write','path':str(WORK/execution_id/'repository/tracked'),'content':'changed'},{'type':'fs_write','path':str(WORK/execution_id/'prove.py'),'content':'import os,errno\nx=[]\nfor f in (lambda:os.chmod("repository/tracked",0o666),lambda:os.rename("repository","moved"),lambda:os.rename(os.getcwd(),os.getcwd()+"-moved")):\n try:f();x.append(0)\n except OSError as e:x.append(e.errno)\nassert x==[errno.EROFS,errno.EBUSY,errno.EROFS],x\n'}, {'type':'terminal','command':'python3','args':['prove.py']}]
        steps += [{'type':'ask_team','question':'Include the report?'},{'type':'publish_artifact','path':'report.txt','displayName':'Report'},{'type':'update','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'The requested task is complete.'}}},{'type':'end'}]
        (APP/'scripts'/'current.json').write_text(json.dumps({'executionId':execution_id,'model':'fixture-model','steps':steps}))
        assert broker('start',execution_id)=={'ok':True,'alreadyAdmitted':False}
        output=pathlib.Path('/var/lib/paws-agent-results')/execution_id
        deadline=time.monotonic()+45;answered=set()
        while not (output/'result.json').exists():
            assert time.monotonic()<deadline,run('/usr/bin/journalctl','-u','paws-agent@'+execution_id+'.service','--no-pager').stdout
            if (output/'events.jsonl').exists():
                for line in (output/'events.jsonl').read_text().splitlines():
                    event=json.loads(line)
                    if event['type'] not in ('question','artifact') or event['requestId'] in answered:continue
                    if event['type']=='artifact':
                        artifact=event['artifact'];assert (output/('artifact-'+artifact['id']+'.bytes')).read_text()=='artifact'
                        answer=json.dumps({'url':'https://fixture.invalid/report'})
                    else:answer='Yes'
                    run(BUN,'--no-env-file',str(APP/'src/index.ts'),'answer',str(agent.pw_gid),execution_id,event['requestId'],answer,preexec_fn=daemon,env={'PATH':'/usr/bin:/bin','HOME':'/var/lib/paws-runner'})
                    answered.add(event['requestId'])
            time.sleep(0.05)
        result=json.loads((output/'result.json').read_text());assert result['run']['stopReason']=='end_turn' and not set(result)&{'candidateSha','reviewText','text'},json.dumps(result)
        trace=json.loads((WORK/execution_id/'agent.json').read_text());assert value['prompt'] in json.dumps(trace['prompts'])
        assert trace['askTeam']['ok']
        assert trace['permissions'][0]['outcome']['outcome']==({'outcome':'cancelled'} if purpose=='answer' else {'outcome':'selected','optionId':'allow'})
        if purpose=='answer':
            assert not trace['fs'][0]['ok'] and not trace['terminals'][0]['ok'] and not trace['artifact']['ok']
            assert trace['tools']==['ask_team'] and len(answered)==1
            assert not (WORK/execution_id/'note.txt').exists() and not (WORK/execution_id/'report.txt').exists()
        else:
            assert trace['fs'][0]['ok'] and trace['terminals'][0]['ok'] and trace['terminals'][0]['exitCode']==0 and trace['artifact']['ok']
            assert trace['tools']==['ask_team','publish_artifact'] and len(answered)==2
            assert (WORK/execution_id/'report.txt').read_text()=='artifact'
        if repository:
            assert trace['fs'][1]['content']=='source-original' and not trace['fs'][2]['ok']
            if purpose=='artifact':assert trace['terminals'][1]['ok'] and trace['terminals'][1]['exitCode']==0
            else:assert not trace['terminals'][1]['ok']
            assert (pathlib.Path('/var/lib/paws-runner-spool')/execution_id/'repository/tracked').read_text()=='source-original'
        assert broker('start',execution_id)=={'ok':True,'alreadyAdmitted':True}
        assert broker('stop',execution_id)=={'ok':True}
        observed.append({'purpose':purpose,'repository':repository,'prompt':True,'answerWriteTerminalPermissionAndArtifactDenied':purpose=='answer','privateTerminalArtifact':purpose=='artifact','questionReply':True,'artifactReply':purpose=='artifact','noCandidateReviewOrTextField':True,'kernelReadonlyRepository':repository,'noRelaunch':True})
    execution_id='0'*25+'5';value=command(execution_id,'answer',False);stage(execution_id,value,False)
    (WORK/execution_id).symlink_to('/var/lib/paws-agent')
    assert broker('start',execution_id)=={'ok':False}
    assert not pathlib.Path('/var/lib/paws-runner-broker',execution_id+'.launched').exists()
    print('PAWS_TASK_WORKER_VM_PROOF '+json.dumps({'passed':True,'pid1':True,'systemd':run('/usr/bin/systemctl','--version').stdout.splitlines()[0],'runnerUid':runner.pw_uid,'agentUid':agent.pw_uid,'cases':observed,'poisonedTaskWorkspaceRefusedBeforeLaunch':True}),flush=True)


main()
