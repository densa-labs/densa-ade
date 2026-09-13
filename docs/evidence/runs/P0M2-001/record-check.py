"""Retain one uniquely named development-check observation without overwriting logs."""
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys

run = pathlib.Path(__file__).parent
check_id, *command = sys.argv[1:]
log = run / (check_id + '.log')
if log.exists():
    raise SystemExit('Refusing to overwrite existing evidence: ' + str(log))
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
with log.open('wb') as output:
    result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
record = {
    'id': check_id, 'class': 'U', 'command': command, 'cwd': str(pathlib.Path.cwd()),
    'startedAt': started, 'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'exitStatus': result.returncode, 'result': 'PASS' if result.returncode == 0 else 'FAIL',
    'artifact': str(log), 'artifactSha256': hashlib.sha256(log.read_bytes()).hexdigest(),
}
(run / (check_id + '.json')).write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
if result.returncode:
    print(log.read_text()[-12000:])
raise SystemExit(result.returncode)
