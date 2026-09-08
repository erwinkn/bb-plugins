"""Temporary, hash-checked transport for the locally tested Voice changes."""
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import subprocess

root = Path.cwd()
bundle = b"".join((root / f".github/voice-operator/part{i}.xz").read_bytes() for i in range(1, 5))
assert len(bundle) == 39836, "Unexpected payload length"
assert hashlib.sha256(bundle).hexdigest() == "c080dbeb9ac11faf148f31404f8af196a6c7c2bf41040f9b6167f07dadc06d1c", "Payload digest mismatch"
data = json.loads(lzma.decompress(bundle))
assert data["version"] == 1
assert data["base"] == "b1423f1ffc12099dcdef51e34eb4a1bc4ef1b662"
subprocess.run(["git", "merge-base", "--is-ancestor", data["base"], "HEAD"], check=True)

def blob_sha(content):
    return hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()

for name, before in data["checks"].items():
    assert re.fullmatch(r"[A-Za-z0-9_./-]+", name) and ".." not in name.split("/"), name
    assert name == "README.md" or name.startswith("plugins/voice-mode/"), name
    assert "node_modules" not in name.split("/"), name
    path = root / name
    assert not path.is_symlink(), name
    if before is None:
        assert not path.exists(), f"New file already exists: {name}"
    else:
        assert blob_sha(path.read_bytes()) == before, f"Source changed: {name}"
assert set(data["after"]) == set(data["checks"]) - {"README.md"}
patch = data["patch"].encode()
numstat = subprocess.check_output(["git", "apply", "--numstat", "--unidiff-zero", "-"], input=patch).decode()
assert {line.split("\t", 2)[2] for line in numstat.splitlines()} == set(data["after"])
subprocess.run(["git", "apply", "--check", "--unidiff-zero", "--whitespace=error", "-"], input=patch, check=True)
subprocess.run(["git", "apply", "--unidiff-zero", "--whitespace=error", "-"], input=patch, check=True)
with (root / "README.md").open("ab") as target:
    target.write(data["rootAppend"].encode())
for name, expected in data["after"].items():
    assert blob_sha((root / name).read_bytes()) == expected, f"Result mismatch: {name}"
subprocess.run(["git", "diff", "--check"], check=True)
manifest = [{"path": name, "sha": blob_sha((root / name).read_bytes())} for name in sorted(data["checks"])]
(Path(os.environ["RUNNER_TEMP"]) / "voice-implementation-manifest.json").write_text(json.dumps(manifest))
print(f"Verified and applied {len(manifest)} files; no unlisted files will be committed.")
