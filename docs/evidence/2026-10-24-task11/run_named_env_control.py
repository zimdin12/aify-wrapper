"""One matched named-file control per arm. Passing is non-reproduction, never cause attribution."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('task11_campaign', HERE / 'run_full_suites.py')
campaign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(campaign)
original = json.loads((HERE / 'full/receipt.json').read_text())
assert original['source_unchanged']
before = campaign.source_state()
assert before == original['after']
OUT = HERE / 'named-env-control'
OUT.mkdir(exist_ok=False)
tests = ['tests/a-second-start-supersedes-the-first.test.js',
         'tests/the-launcher-and-aify-env-name-one-home.test.js', 'tests/herdr-identity.test.js']
env = dict(os.environ)
for key, value in original['pins'].items():
    if value is None:
        env.pop(key, None)
    else:
        env[key] = value
receipt = {'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'before': before, 'runs': []}
for arm, wrapper in [('baseline', campaign.BASE_WRAPPER), ('candidate', campaign.WRAPPER)]:
    command = [original['shell'], '-c', 'npm test -- ' + ' '.join(tests)]
    log = OUT / (arm + '.txt')
    started = time.monotonic()
    with log.open('xb') as stream:
        result = subprocess.run(command, cwd=campaign.ENV, env=dict(env, AIFY_WRAPPER_REPO=str(wrapper)),
                                stdout=stream, stderr=subprocess.STDOUT)
    receipt['runs'].append({'arm': arm, 'wrapper_repo': str(wrapper), 'command': command,
                            'cwd': str(campaign.ENV), 'exit_code': result.returncode,
                            'elapsed_s': round(time.monotonic() - started, 3), 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()})
receipt['after'] = campaign.source_state()
receipt['source_unchanged'] = receipt['before'] == receipt['after']
(OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8', newline='\n')
print(json.dumps({'runs': receipt['runs'], 'source_unchanged': receipt['source_unchanged']}, indent=2))
raise SystemExit(0 if receipt['source_unchanged'] and all(r['exit_code'] == 0 for r in receipt['runs']) else 1)
