"""Verify and extract the exact Python #170 release-profile Linux wheel used for desktop acceptance.

Usage: python scripts/verify_candidate_wheel.py ARCHIVE OUTPUT_DIRECTORY
The CI archive includes the tested synthetic merge SHA, not just the PR head SHA.
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

ARCHIVE_SHA256 = '98efe82e76f74baa6e5a341349cf26369f1da20625db9986177a646216037b6b'
WHEEL = 'dist/intentumdiff_python-0.0.2b1-py3-none-linux_x86_64.whl'
WHEEL_SHA256 = '57532947a3ee5d4c5af9a3943f4f9e562df7084f6f04f3cd76e0c9bb9b0830e6'
PYTHON_COMMIT = 'bf422bf4983cfadb5a95835a8f37af389d0a2a7b'
CORE_COMMIT = 'a7a954bb875d73c132b8d2df6ddb5e3cedddd7a2'
ARTIFACT_ID = 12886528378


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
                    archive_sha256=ARCHIVE_SHA256, workflow_run=40842662778)
    (destination / 'runtime-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    print(json.dumps(identity))


if __name__ == '__main__':
    verify(*sys.argv[1:])
