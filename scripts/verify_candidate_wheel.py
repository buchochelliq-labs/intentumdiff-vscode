"""Verify and extract the exact Python #101 release-profile Linux wheel used for desktop acceptance.

Usage: python scripts/verify_candidate_wheel.py ARCHIVE OUTPUT_DIRECTORY
The CI archive includes the tested synthetic merge SHA, not just the PR head SHA.
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

ARCHIVE_SHA256 = '1af9dff7c6a6bd81cb489aa536227ed34462f7769ee00e37825393e6a3be9952'
WHEEL = 'dist/intentumdiff_python-0.0.2b1-py3-none-linux_x86_64.whl'
WHEEL_SHA256 = 'd170cfc1018a8c269ac13768c221de79fe6f7c069cd1a14232f30d4efafbfa81'
PYTHON_COMMIT = 'acea09f11a4c278a1884eb882dcad14d3b8e72b9'
CORE_COMMIT = '89c11a806b3f6368a3f502d77aa35698cdf38cba'
ARTIFACT_ID = 11530894250


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
                    archive_sha256=ARCHIVE_SHA256, workflow_run=37730861529)
    (destination / 'runtime-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    print(json.dumps(identity))


if __name__ == '__main__':
    verify(*sys.argv[1:])
