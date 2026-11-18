"""Verify and extract the exact Python 99aeb3e (Core 1c4bdbc) 0.0.3b1 release-profile Linux wheel used for desktop acceptance.

Usage: python scripts/verify_candidate_wheel.py ARCHIVE OUTPUT_DIRECTORY
The CI archive includes the tested synthetic merge SHA, not just the PR head SHA.
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

ARCHIVE_SHA256 = 'cf35a90e7dddb47d31923820def803c097d4ac75672a3563ecfd91d71c06c589'
WHEEL = 'dist/intentumdiff_python-0.0.3b1-py3-none-manylinux_2_39_x86_64.whl'
WHEEL_SHA256 = '42f473ae34dce6d78dfe19c86c3bf1c8967ba658b6059c8185b669df78ae34ec'
PYTHON_COMMIT = '99aeb3ebc127455af62f5db4fa477498f4f852fa'
CORE_COMMIT = '1c4bdbc5dfbe6e738b3d70d8964e7f148d711821'
ARTIFACT_ID = 14421310046


def verify(archive_path, destination):
    data = Path(archive_path).read_bytes()
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise ValueError('Candidate archive checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for filename, expected in [('python-tested-commit.txt', PYTHON_COMMIT),
                                   ('core-commit.txt', CORE_COMMIT)]:
            if archive.read('evidence/' + filename).decode().strip() != expected:
                raise ValueError(f'Candidate {filename} mismatch')
        if archive.read('evidence/wheel-build-profile.txt').decode().strip() != 'release':
            raise ValueError('Candidate wheel must use release profile')
        wheel = archive.read(WHEEL)
        if hashlib.sha256(wheel).hexdigest() != WHEEL_SHA256:
            raise ValueError('Candidate wheel checksum mismatch')
        # Extract only known files, never archive-controlled paths.
        destination = Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        (destination / Path(WHEEL).name).write_bytes(wheel)
        for filename in ['wasm_provenance.json', 'wheels.sha256',
                         'python-tested-commit.txt', 'core-commit.txt', 'wheel-build-profile.txt']:
            (destination / filename).write_bytes(archive.read('evidence/' + filename))
    identity = dict(python_commit=PYTHON_COMMIT, core_commit=CORE_COMMIT,
                    wheel_sha256=WHEEL_SHA256, artifact_id=ARTIFACT_ID,
                    archive_sha256=ARCHIVE_SHA256, workflow_run=44279129426)
    (destination / 'runtime-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    print(json.dumps(identity))


if __name__ == '__main__':
    verify(*sys.argv[1:])
