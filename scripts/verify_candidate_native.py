"""Verify a pinned native CI archive before extracting it for acceptance tests."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import zipfile

COMPONENT_WHEEL_SHA256 = '1919afa822f5e5bc9b3106d88a0e08c1795dbdd78da99662625f61e9d503faf5'
COMPONENT_CORE_COMMIT = '89c11a806b3f6368a3f502d77aa35698cdf38cba'
COMPONENT_PYTHON_COMMIT = 'd46fd0e8fb3c65bb9d77ab14c95ebcb7c5798d54'
TARBALL = 'intentumdiff-live-server-linux-x64.tar.gz'
ROOT = 'intentumdiff-live-server'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked(data, expected, label):
    if digest(data) != expected:
        raise ValueError(f'{label} checksum mismatch')


def safe_path(name):
    if (not name or '\\' in name or ':' in name or name.startswith('/')
            or any(p in ('', '.', '..') for p in name.split('/'))):
        raise ValueError(f'Unsafe archive path: {name!r}')
    return PurePosixPath(name)


def checksums(data):
    result = {}
    for line in data.decode('utf-8').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not match:
            raise ValueError('Malformed SHA256SUMS')
        value, name = match.groups()
        safe_path(name)
        if name in result:
            raise ValueError('Duplicate checksum entry')
        result[name] = value
    return result


def verify(archive_path, destination, *, expected_archive_sha256,
           expected_server_commit, expected_core_commit):
    for value, length in [(expected_archive_sha256, 64), (expected_server_commit, 40), (expected_core_commit, 40)]:
        if not re.fullmatch(r'[0-9a-f]{%d}' % length, value):
            raise ValueError('Expected identities must be full lowercase hashes')
    data = Path(archive_path).read_bytes()
    checked(data, expected_archive_sha256, 'Outer archive')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        outer = {}
        for info in archive.infolist():
            safe_path(info.filename)
            mode = info.external_attr >> 16
            if info.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
                raise ValueError('Outer archive must contain regular files only')
            if info.filename in outer:
                raise ValueError('Duplicate outer member')
            outer[info.filename] = archive.read(info)
    if set(outer) != {TARBALL, 'SHA256SUMS', 'provenance.json'}:
        raise ValueError('Unexpected outer archive members')
    sums = checksums(outer['SHA256SUMS'])
    if set(sums) != {TARBALL}:
        raise ValueError('Unexpected outer checksum members')
    checked(outer[TARBALL], sums[TARBALL], 'Native tarball')
    members, modes = {}, {}
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(outer[TARBALL]), mode='r:gz') as archive:
        for entry in archive:
            path = safe_path(entry.name)
            if entry.name in seen:
                raise ValueError('Duplicate tar member')
            seen.add(entry.name)
            if path.parts[0] != ROOT or not (entry.isdir() or entry.isfile()):
                raise ValueError('Unexpected tar path or member type')
            relative = '/'.join(path.parts[1:])
            if entry.isdir():
                if relative not in ('', 'wasm'):
                    raise ValueError('Unexpected tar directory')
                continue
            if not relative or entry.mode & 0o7000:
                raise ValueError('Invalid tar file mode/path')
            if relative not in (ROOT, 'provenance.json', 'SHA256SUMS') and not (
                    len(path.parts) == 3 and path.parts[1] == 'wasm'):
                raise ValueError('Unexpected native bundle member')
            members[relative] = archive.extractfile(entry).read()
            modes[relative] = entry.mode
    required = {ROOT, 'provenance.json', 'SHA256SUMS', 'wasm/component-source.json',
                'wasm/wasm_provenance.json', 'wasm/parser_manifest.json'}
    if not required <= members.keys():
        raise ValueError('Incomplete native bundle')
    sums_inner = checksums(members['SHA256SUMS'])
    if set(sums_inner) != set(members) - {'SHA256SUMS'}:
        raise ValueError('Unverified or missing native bundle members')
    for name, expected in sums_inner.items():
        checked(members[name], expected, name)
    if members['provenance.json'] != outer['provenance.json']:
        raise ValueError('Outer/inner provenance mismatch')
    provenance = json.loads(members['provenance.json'])
    if (provenance['server_commit'] != expected_server_commit or provenance['core_commit'] != expected_core_commit
            or provenance['protocol_version'] != 2 or provenance['transport'] != 'stdio'):
        raise ValueError('Native provenance mismatch')
    components = json.loads(members['wasm/component-source.json'])
    if (components != provenance['components'] or components['wheel_sha256'] != COMPONENT_WHEEL_SHA256
            or components['component_core_commit'] != COMPONENT_CORE_COMMIT
            or components['python_commit'] != COMPONENT_PYTHON_COMMIT
            or components.get('artifact_id') != 11514272993
            or components.get('workflow_run') != 37689207055
            or components.get('archive_sha256') != '9f3f63c54cde55b1e7e0cc55073eb20df28753098d215823510ba692a1b991e0'):
        raise ValueError('Component provenance mismatch')
    wasm = json.loads(members['wasm/wasm_provenance.json'])
    artifacts = wasm['artifacts']
    actual = {name.removeprefix('wasm/') for name in members if name.endswith('.wasm')}
    if not actual or actual != set(artifacts) or wasm['artifact_count'] != len(actual):
        raise ValueError('Wasm manifest membership mismatch')
    for name, record in artifacts.items():
        safe_path(name)
        if '/' in name:
            raise ValueError('Nested Wasm artifact')
        payload = members['wasm/' + name]
        checked(payload, record['sha256'], name)
        if len(payload) != record['size_bytes']:
            raise ValueError('Wasm size mismatch')
    if not json.loads(members['wasm/parser_manifest.json']) or not modes[ROOT] & 0o111:
        raise ValueError('Empty parser manifest or non-executable binary')
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('Destination must not exist')
    identity = dict(server_commit=expected_server_commit, core_commit=expected_core_commit,
                    archive_sha256=expected_archive_sha256, tarball_sha256=digest(outer[TARBALL]),
                    binary_sha256=digest(members[ROOT]), component_wheel_sha256=COMPONENT_WHEEL_SHA256,
                    protocol_version=2, transport='stdio')
    destination.mkdir(parents=True)
    for name, payload in members.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        target.chmod(0o755 if name == ROOT else 0o644)
    (destination / 'runtime-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--expected-archive-sha256', required=True)
    parser.add_argument('--expected-server-commit', required=True)
    parser.add_argument('--expected-core-commit', required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.destination,
        expected_archive_sha256=args.expected_archive_sha256,
        expected_server_commit=args.expected_server_commit,
        expected_core_commit=args.expected_core_commit)))


if __name__ == '__main__':
    main()
