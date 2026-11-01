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

ARCHIVE_SHA256 = '3a13ca170b2399429d14fcb51aa137ed39bf283095481871cb715c47901ad814'
WHEEL = 'dist/intentumdiff_python-0.0.2b1-py3-none-linux_x86_64.whl'
WHEEL_SHA256 = '14b48d7b1f38f1e49fa58393b1444c0cfa5de61221effbe82577740f5ba52a67'
PYTHON_COMMIT = '8c3f424f42c72c9ef814cd3c3ed639537c5b183e'
CORE_COMMIT = '80f9c5bf64ff42ef1b7ddf4124c6b19a7ca7695c'
ARTIFACT_ID = 13099160262


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
                    archive_sha256=ARCHIVE_SHA256, workflow_run=41339401182)
    (destination / 'runtime-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    print(json.dumps(identity))


if __name__ == '__main__':
    verify(*sys.argv[1:])
