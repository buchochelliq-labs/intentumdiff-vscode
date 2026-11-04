"""Artifact identity mismatches must fail before extracting a candidate wheel."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import verify_candidate_wheel as candidate


class CandidateWheelTests(unittest.TestCase):
    def fixture(self, python_commit=candidate.PYTHON_COMMIT, wheel=b'test wheel', profile='release'):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr(candidate.WHEEL, wheel)
            archive.writestr('evidence/python-tested-commit.txt', python_commit)
            archive.writestr('evidence/core-commit.txt', candidate.CORE_COMMIT)
            archive.writestr('evidence/wheel-build-profile.txt', profile)
            archive.writestr('evidence/wasm_provenance.json', '{}')
            archive.writestr('evidence/wheels.sha256', 'fixture')
        return stream.getvalue()

    def check(self, data, archive_hash, wheel_hash, error=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'candidate.zip'
            dest = Path(directory) / 'output'
            path.write_bytes(data)
            with patch.object(candidate, 'ARCHIVE_SHA256', archive_hash), \
                 patch.object(candidate, 'WHEEL_SHA256', wheel_hash):
                if error:
                    with self.assertRaisesRegex(ValueError, error):
                        candidate.verify(path, dest)
                    self.assertFalse(dest.exists())
                else:
                    candidate.verify(path, dest)
                    self.assertEqual((dest / Path(candidate.WHEEL).name).read_bytes(), b'test wheel')

    def test_verified_archive(self):
        data = self.fixture()
        self.check(data, hashlib.sha256(data).hexdigest(), hashlib.sha256(b'test wheel').hexdigest())

    def test_archive_mismatch(self):
        self.check(self.fixture(), 'wrong', 'unused', 'archive checksum')

    def test_commit_mismatch(self):
        data = self.fixture(python_commit='wrong')
        self.check(data, hashlib.sha256(data).hexdigest(), 'unused', 'commit.txt mismatch')

    def test_dev_profile_is_rejected(self):
        data = self.fixture(profile='dev')
        self.check(data, hashlib.sha256(data).hexdigest(), 'unused', 'release profile')

    def test_wheel_mismatch(self):
        data = self.fixture()
        self.check(data, hashlib.sha256(data).hexdigest(), 'wrong', 'wheel checksum')


if __name__ == '__main__':
    unittest.main()
