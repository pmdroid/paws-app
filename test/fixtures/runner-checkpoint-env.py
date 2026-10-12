import json
import os
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({"github": "GH_TOKEN" in os.environ}))
sys.stdout.buffer.write(b"token\0")
