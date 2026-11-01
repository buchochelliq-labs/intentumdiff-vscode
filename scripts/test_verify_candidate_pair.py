"""Independent negative controls for the RC cross-runtime identity gate."""
import unittest
from verify_candidate_pair import verify_pair


class PairIdentityTests(unittest.TestCase):
    def setUp(self):
        self.wheel = dict(wheel_sha256="a" * 64, python_commit="b" * 40, core_commit="c" * 40)

    def test_matching_immutable_identities(self):
        verify_pair(self.wheel, self.wheel.copy())

    def test_any_mismatch_fails_closed(self):
        for key in ("wheel_sha256", "python_commit", "core_commit"):
            with self.subTest(key=key):
                native = self.wheel.copy()
                native[key] = "0" * len(native[key])
                with self.assertRaisesRegex(ValueError, key):
                    verify_pair(self.wheel, native)

    def test_missing_identity_fails_closed(self):
        for key in ("wheel_sha256", "python_commit", "core_commit"):
            with self.subTest(key=key):
                native = self.wheel.copy()
                native.pop(key)
                with self.assertRaisesRegex(ValueError, key):
                    verify_pair(self.wheel, native)


if __name__ == "__main__":
    unittest.main()
