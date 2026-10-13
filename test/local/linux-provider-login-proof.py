import hashlib
import importlib.util
import json
import os
import pathlib
import pwd
import shlex
import subprocess
import tempfile


ROOT = pathlib.Path('/proof')
spec = importlib.util.spec_from_file_location('fixture', ROOT / 'source.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def main():
    if os.getuid() != 0 or pathlib.Path('/opt/paws-runner').exists():
        raise RuntimeError('Use a fresh disposable root namespace')
    fixture.provision_tools()
    os.umask(0o077)
    with tempfile.TemporaryDirectory() as temporary:
        signing = pathlib.Path(temporary)
        private = signing / 'private.pem'
        public = signing / 'public.pem'
        signature = signing / 'manifest.sig'
        fixture.run(['/usr/bin/openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(private)])
        fixture.run(['/usr/bin/openssl', 'pkey', '-in', str(private), '-pubout', '-out', str(public)])
        fixture.run(['/usr/bin/openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', str(private), '-in', str(ROOT / 'package/manifest.json'), '-out', str(signature)])
        installed = json.loads(fixture.run(['/usr/bin/python3', str(ROOT / 'install.py'), '--artifact', str(ROOT / 'package/artifact.tar'), '--manifest', str(ROOT / 'package/manifest.json'), '--signature', str(signature), '--release-key', str(public)]))
        agent = pwd.getpwnam('paws-agent')
        runner = pwd.getpwnam('paws-runner')
        env = {'PATH': '/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': agent.pw_dir, 'LANG': 'C'}
        def agent_identity():
            os.setgroups(os.getgrouplist(agent.pw_name, agent.pw_gid))
            os.setgid(agent.pw_gid)
            os.setuid(agent.pw_uid)
        checks_script = ROOT / 'login-status.ts'
        checks_script.write_text('import { checkDeveloperLogins } from "/opt/paws-runner/current/src/install/index.ts";console.log(JSON.stringify(await checkDeveloperLogins({env:process.env})));')
        checks_script.chmod(0o644)
        status = subprocess.run(['/opt/paws-runner/bin/bun', '--no-env-file', str(checks_script)], env=env, cwd=agent.pw_dir, preexec_fn=agent_identity, capture_output=True, text=True, timeout=30)
        if status.returncode != 0:
            raise RuntimeError(status.stderr)
        checks = json.loads(status.stdout)
        if any(check['exitCode'] != 1 or check['loggedIn'] or check['summary'].endswith('is not installed') for check in checks.values()):
            raise RuntimeError('Bundled logged-out status did not execute: ' + json.dumps(checks))
        versions = {}
        login_help = {}
        for provider, command in installed['providerLoginCommands'].items():
            args = shlex.split(command)
            if args[:8] != ['/usr/sbin/runuser', '--user', 'paws-agent', '--', '/usr/bin/env', '-i', '--chdir=/var/lib/paws-agent', 'HOME=/var/lib/paws-agent']:
                raise RuntimeError('Operator login identity or HOME is not fixed')
            executable = '/opt/paws-runner/bin/' + provider
            position = args.index(executable)
            poisoned = {'HOME': '/root', 'PATH': '/nonexistent', 'CLAUDE_CODE_OAUTH_TOKEN': 'synthetic-parent-secret', 'OPENAI_API_KEY': 'synthetic-parent-secret'}
            version = subprocess.run(args[:position + 1] + ['--version'], env=poisoned, cwd='/root', capture_output=True, text=True, timeout=30)
            help_result = subprocess.run(args + ['--help'], env=poisoned, cwd='/root', capture_output=True, text=True, timeout=30)
            if version.returncode != 0 or help_result.returncode != 0:
                raise RuntimeError(version.stderr + help_result.stderr)
            versions[provider] = version.stdout.strip()
            login_help[provider] = help_result.stdout
            launcher = pathlib.Path('/opt/paws-runner/current/node_modules/.bin') / provider
            if launcher.is_symlink() or launcher.stat().st_mode & 0o7777 != 0o755:
                raise RuntimeError('Provider launcher is not a regular executable')
            if os.readlink('/opt/paws-runner/bin/' + provider) != '../current/node_modules/.bin/' + provider:
                raise RuntimeError('Provider pointer does not select current')
        script = ROOT / 'scripted-login.py'
        script.write_text("import os,pathlib,pwd,sys\nagent=pwd.getpwnam('paws-agent')\nassert os.getuid()==agent.pw_uid and os.getgid()==agent.pw_gid\nassert set(os.environ)<= {'HOME','PATH','LANG','LC_CTYPE'}\nassert os.environ['HOME']==agent.pw_dir and os.getcwd()==agent.pw_dir\nassert not pathlib.Path('/var/lib/paws-runner').exists() or not os.access('/var/lib/paws-runner',os.R_OK)\nprovider=sys.argv[1]\ncredential=pathlib.Path(agent.pw_dir)/('.'+provider)/'synthetic-credential'\ncredential.parent.mkdir(mode=0o700,exist_ok=True)\ncredential.write_text('synthetic-agent-only-login')\ncredential.chmod(0o600)\n")
        script.chmod(0o644)
        isolation = {}
        for provider, command in installed['providerLoginCommands'].items():
            args = shlex.split(command)
            position = args.index('/opt/paws-runner/bin/' + provider)
            scripted = subprocess.run(args[:position] + ['/usr/bin/python3', '-I', '-B', str(script), provider], env={'HOME': '/root', 'PATH': '/nonexistent', 'OPENAI_API_KEY': 'synthetic-parent-secret'}, cwd='/root', capture_output=True, text=True, timeout=30)
            if scripted.returncode != 0 or scripted.stdout or scripted.stderr:
                raise RuntimeError('Scripted operator login failed: ' + scripted.stderr)
            credential = pathlib.Path(agent.pw_dir) / ('.' + provider) / 'synthetic-credential'
            info = credential.stat()
            def runner_identity():
                os.setgroups(os.getgrouplist(runner.pw_name, runner.pw_gid))
                os.setgid(runner.pw_gid)
                os.setuid(runner.pw_uid)
            denied = subprocess.run(['/usr/bin/python3', '-I', '-c', "import pathlib;pathlib.Path(" + repr(str(credential)) + ").read_bytes()"], env={'PATH': '/usr/bin:/bin', 'HOME': runner.pw_dir}, cwd='/', preexec_fn=runner_identity, capture_output=True, text=True, timeout=10)
            if info.st_uid != agent.pw_uid or info.st_mode & 0o7777 != 0o600 or denied.returncode == 0:
                raise RuntimeError('Agent credential isolation failed')
            isolation[provider] = {'uid': info.st_uid, 'mode': oct(info.st_mode & 0o7777), 'daemonReadDenied': True}
        observations = {'verified': True, 'installerSha256': hashlib.sha256((ROOT / 'install.py').read_bytes()).hexdigest(), 'packageManifest': json.loads((ROOT / 'package/manifest.json').read_text()), 'agentUid': agent.pw_uid, 'runnerUid': runner.pw_uid, 'actualStatusChecks': checks, 'versions': versions, 'operatorLoginCommands': installed['providerLoginCommands'], 'loginHelp': login_help, 'scriptedCredentialIsolation': isolation, 'vendorLoginInvoked': False, 'network': 'none', 'systemctlBackend': 'recording fixture'}
        (ROOT / 'observations.json').write_text(json.dumps(observations, indent=2) + '\n')
        print(json.dumps(observations))


if __name__ == '__main__':
    main()
