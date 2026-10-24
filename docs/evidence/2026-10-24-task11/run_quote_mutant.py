"""Kill the PowerShell single-quote escape in a private export, never in the campaign checkout."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
EXPORT = Path('C:/Users/Administrator/AppData/Local/hermes/cache/scratch/task11-quote-mutant')
TREE = '0d076ece4df68f0dd7c62326174000e130f1b626'
TARGET = Path('lib/channel-install.mjs')
TEST = 'tests/a-denied-channel-policy-write-names-the-elevated-command.test.js'

archive = subprocess.check_output(['git', '-C', str(ROOT), 'archive', TREE])
EXPORT.mkdir(exist_ok=False)
with tarfile.open(fileobj=io.BytesIO(archive)) as packed:
    packed.extractall(EXPORT, filter='data')
file = EXPORT / TARGET
original = file.read_bytes()
needle = b'word.replaceAll("\'", "\'\'")'
assert original.count(needle) == 1
file.write_bytes(original.replace(needle, b'word'))
env = dict(os.environ, TMPDIR=str(EXPORT.parent / 'task11'), TEMP=str(EXPORT.parent / 'task11'), TMP=str(EXPORT.parent / 'task11'))
log = OUT / 'quote-mutant.txt'
with log.open('xb') as stream:
    result = subprocess.run([shutil.which('node'), 'tests/run-in-a-temp-root.mjs', TEST], cwd=EXPORT,
                            env=env, stdout=stream, stderr=subprocess.STDOUT)
file.write_bytes(original)
assert file.read_bytes() == original
text = log.read_text(encoding='utf-8')
intended = result.returncode == 1 and '# tests 1' in text and '# fail 1' in text and 'AssertionError' in text
# The native parser's errors=0 assertion, not an unrelated fixture or runner failure, must reject the mutant.
expected_line, = [number for number, line in enumerate((EXPORT / TEST).read_text(encoding='utf-8').splitlines(), 1)
                  if 'assert.equal(syntax.errors, 0, command)' in line]
intended = intended and f':{expected_line}:' in text
receipt = {'tree': TREE, 'archive_sha256': hashlib.sha256(archive).hexdigest(),
           'target': str(TARGET), 'original_sha256': hashlib.sha256(original).hexdigest(),
           'exit_code': result.returncode, 'intended_assertion_failed': intended,
           'export_restored': file.read_bytes() == original, 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()}
(OUT / 'quote-mutant.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8', newline='\n')
print(json.dumps(receipt, indent=2))
raise SystemExit(0 if intended else 1)
