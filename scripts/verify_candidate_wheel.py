"""Verify and extract the exact Python 09fb939 (Core 726fd07) 0.0.2 release-profile Linux wheel used for desktop acceptance.

Usage: python scripts/verify_candidate_wheel.py ARCHIVE OUTPUT_DIRECTORY
The CI archive includes the tested synthetic merge SHA, not just the PR head SHA.
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

ARCHIVE_SHA256 = '401bc5a6f09a149774a57d33f427aebdfbaee86bc939945b8368b19a8306fabb'
WHEEL = 'dist/intentumdiff_python-0.0.2-py3-none-manylinux_2_39_x86_64.whl'
WHEEL_SHA256 = 'a6003f8443e64293d0a8e5feee8df0ef5db15b60ab738e265e30a49dcf1a5d87'
PYTHON_COMMIT = '09fb9396a15a47327f505a8994b409d721ab18e2'
CORE_COMMIT = '726fd07c77a83d2554d3eca68b6469e9461b87bc'
ARTIFACT_ID = 13290975305


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
                    archive_sha256=ARCHIVE_SHA256, workflow_run=41750200742)
    (destination / 'runtime-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    print(json.dumps(identity))


if __name__ == '__main__':
    verify(*sys.argv[1:])
