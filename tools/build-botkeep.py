"""Build an explicit allowlist ZIP; no Git metadata, secrets, weights or runtime data."""
from pathlib import Path
import hashlib
import json
import sys
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent / "roadwatch-botkeep.zip"
files = {"collector.py": root / "collector/collector.py", "publisher.py": root / "collector/publisher.py"}
for name in ["main.py", "requirements.txt", "config.json", "model.lock.json", "README.md", "THIRD_PARTY_NOTICES.md"]:
    files[name] = root / "collector/botkeep" / name
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name, path in files.items(): archive.writestr(name, path.read_bytes())
print(json.dumps({"archive": str(output), "bytes": output.stat().st_size,
                  "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "files": list(files)}))
