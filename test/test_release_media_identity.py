import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location("media", Path(__file__).resolve().parents[1] / "scripts/validate_release_media_manifest.py")
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)
class IdentityTests(unittest.TestCase):
    def test_missing_and_stale_identity_fail_before_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_text(json.dumps({"screenshots": [{}]}))
            with self.assertRaisesRegex(AssertionError, "expected-commit"):
                media.validate_manifest(manifest)
            for entry, expected in [({}, "extension_version"), ({"extension_version": "old"}, "extension_version"), ({"extension_version": "new", "commit": "a" * 40}, "commit is stale")]:
                manifest.write_text(json.dumps({"screenshots": [entry]}))
                with self.assertRaisesRegex(AssertionError, expected):
                    media.validate_manifest(manifest, expected_version="new", expected_commit="b" * 40)
if __name__ == "__main__": unittest.main()
