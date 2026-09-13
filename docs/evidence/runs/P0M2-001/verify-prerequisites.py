"""Read-only verification of retained prerequisite evidence and committed producer files."""
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path.cwd()
sha = lambda data: hashlib.sha256(data).hexdigest()
history = json.loads((root / 'docs/evidence/runs/P0M2-001/authority-history.json').read_text())
for path, digest in history['currentAuthorityHashes'].items():
    assert sha((root / path).read_bytes()) == digest, path
results = []
for milestone, commit in [('P0M0', 'bad38bdafa0c6c1024b8a2033cce5675808cbfd0'), ('P0M1', '18a0791f9508a4c5c2a371f15c0e8ebbda1112c2')]:
    run = root / 'docs/evidence/runs' / (milestone + '-001')
    acceptance = json.loads((run / 'acceptance.json').read_text())
    manifest_bytes = (run / 'candidate.json').read_bytes()
    assert sha(manifest_bytes) == acceptance['candidateManifestSha256']
    tracked = set(subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', commit], text=True).splitlines())
    entries = json.loads(manifest_bytes)
    for entry in entries:
        path = entry['path']
        if path in tracked:
            data = subprocess.check_output(['git', 'show', commit + ':' + path])
        elif path in history['originalSnapshots']:
            data = (root / history['originalSnapshots'][path]['path']).read_bytes()
        else:
            data = (root / path).read_bytes()
        assert sha(data) == entry['sha256'], (milestone, path)
    artifacts = json.loads((run / 'artifacts.json').read_text())
    for name, expected in artifacts.items():
        assert sha((run / name).read_bytes()) == expected, (milestone, name)
    results.append({'id': acceptance['id'], 'commit': commit, 'candidateManifestSha256': sha(manifest_bytes), 'candidateFilesVerified': len(entries), 'artifactHashesVerified': len(artifacts)})
print(json.dumps({'result': 'PASS', 'prerequisites': results, 'currentAuthorityHashes': history['currentAuthorityHashes'], 'note': 'Producer commit snapshots and exact original authority snapshots verified; current authority changes are assessed in authority-history.json and R7a.'}, indent=2))
