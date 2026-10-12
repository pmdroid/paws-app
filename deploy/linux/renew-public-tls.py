import subprocess
import sys

if len(sys.argv) != 1:
    raise SystemExit(1)

raise SystemExit(subprocess.run(
    ["/usr/bin/systemctl", "reload", "paws.service"],
    env={"PATH": "/usr/bin:/bin"},
    check=False,
).returncode)
