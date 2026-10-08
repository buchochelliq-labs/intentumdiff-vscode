"""Synthetic archive fixtures test validation; they are not acceptance candidates."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile
import verify_candidate_native as v

SERVER = '1' * 40
CORE = '2' * 40


def encoded(value):
    return json.dumps(value).encode()


def fixture(mutation=None, tar_extra=None, outer_extra=None, stale_outer_sum=False):
    component = dict(wheel_sha256=v.COMPONENT_WHEEL_SHA256,
                     component_core_commit=v.COMPONENT_CORE_COMMIT, python_commit=v.COMPONENT_PYTHON_COMMIT, artifact_id=11514272993,
                     workflow_run=37689207055, archive_sha256='9f3f63c54cde55b1e7e0cc55073eb20df28753098d215823510ba692a1b991e0')
    provenance = dict(server_commit=SERVER, core_commit=CORE, components=component,
                      protocol_version=2, transport='stdio')
    files = {v.ROOT: b'synthetic test executable', 'provenance.json': encoded(provenance),
             'wasm/component-source.json': encoded(component), 'wasm/parser_manifest.json': b'{"parsers":{}}',
             'wasm/test.wasm': b'\0asm-test',
             'wasm/wasm_provenance.json': encoded({'artifact_count': 1, 'artifacts': {
                 'test.wasm': {'sha256': v.digest(b'\0asm-test'), 'size_bytes': 9}}})}
    if mutation:
        mutation(files)
    files['SHA256SUMS'] = ''.join(f'{v.digest(data)}  {name}\n' for name, data in files.items()).encode()
    tar_data = io.BytesIO()
    with tarfile.open(fileobj=tar_data, mode='w:gz') as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(v.ROOT + '/' + name)
            info.size, info.mode = len(data), 0o755 if name == v.ROOT else 0o644
            archive.addfile(info, io.BytesIO(data))
        if tar_extra:
            archive.addfile(tar_extra)
    payload = tar_data.getvalue()
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, 'w') as archive:
        archive.writestr(v.TARBALL, payload)
        archive.writestr('SHA256SUMS', f'{"0" * 64 if stale_outer_sum else v.digest(payload)}  {v.TARBALL}\n')
        archive.writestr('provenance.json', files['provenance.json'])
        if outer_extra:
            archive.writestr(outer_extra, b'bad')
    return outer.getvalue()


class NativeVerifierTests(unittest.TestCase):
    def run_bundle(self, payload, **overrides):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'bundle.zip'
            path.write_bytes(payload)
            destination = Path(root) / 'verified'
            kwargs = dict(expected_archive_sha256=v.digest(payload), expected_server_commit=SERVER,
                          expected_core_commit=CORE)
            kwargs.update(overrides)
            try:
                result = v.verify(path, destination, **kwargs)
            except Exception:
                self.assertFalse(destination.exists(), 'Rejected bundles must not be extracted')
                raise
            self.assertTrue((destination / v.ROOT).stat().st_mode & 0o111)
            self.assertEqual(json.loads((destination / 'runtime-identity.json').read_text()), result)
            return result

    def test_valid_bundle_extracts_executable_and_identity(self):
        self.assertEqual(self.run_bundle(fixture())['server_commit'], SERVER)

    def test_outer_hash_mismatch(self):
        with self.assertRaisesRegex(ValueError, 'Outer archive checksum'):
            self.run_bundle(fixture(), expected_archive_sha256='0' * 64)

    def test_tar_hash_mismatch(self):
        with self.assertRaisesRegex(ValueError, 'tarball checksum'):
            self.run_bundle(fixture(stale_outer_sum=True))

    def test_expected_commits_are_enforced(self):
        for key in ('expected_server_commit', 'expected_core_commit'):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'Native provenance'):
                self.run_bundle(fixture(), **{key: '3' * 40})

    def test_wasm_hash_and_size_are_independently_enforced(self):
        def wrong_hash(files):
            files['wasm/test.wasm'] = b'corrupted'
        def wrong_size(files):
            manifest = json.loads(files['wasm/wasm_provenance.json'])
            manifest['artifacts']['test.wasm']['size_bytes'] = 500
            files['wasm/wasm_provenance.json'] = encoded(manifest)
        for mutation, error in [(wrong_hash, 'checksum mismatch'), (wrong_size, 'size mismatch')]:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                self.run_bundle(fixture(mutation))

    def test_component_wheel_provenance_is_pinned(self):
        def mutate(files):
            source = json.loads(files['wasm/component-source.json'])
            source['wheel_sha256'] = '0' * 64
            files['wasm/component-source.json'] = encoded(source)
            provenance = json.loads(files['provenance.json'])
            provenance['components'] = source
            files['provenance.json'] = encoded(provenance)
        with self.assertRaisesRegex(ValueError, 'Component provenance'):
            self.run_bundle(fixture(mutate))

    def test_traversal_links_and_unverified_members_rejected(self):
        for name, kind in [(v.ROOT + '/../escape', tarfile.REGTYPE),
                           (v.ROOT + '/wasm/link', tarfile.SYMTYPE),
                           (v.ROOT + '/wasm/hardlink', tarfile.LNKTYPE),
                           (v.ROOT + '/wasm/unverified', tarfile.REGTYPE),
                           ('/absolute', tarfile.REGTYPE)]:
            entry = tarfile.TarInfo(name)
            entry.type, entry.linkname = kind, '/tmp/outside'
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.run_bundle(fixture(tar_extra=entry))
        with self.assertRaisesRegex(ValueError, 'Unsafe archive path'):
            self.run_bundle(fixture(outer_extra='../escape'))


if __name__ == '__main__':
    unittest.main()
