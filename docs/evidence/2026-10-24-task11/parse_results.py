"""Verify retained log hashes and parse reporter fields without treating absent output as zero."""
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
receipt = json.loads((HERE / 'full/receipt.json').read_text())
assert receipt['source_unchanged']


def tap(text):
    fields = {}
    for name in ('tests', 'pass', 'fail', 'cancelled', 'skipped'):
        values = re.findall(r'^# ' + name + r' (\d+)\s*$', text, re.M)
        if not values:
            raise ValueError('missing reporter field: ' + name)
        fields[name] = int(values[-1])
    return fields


assert tap((HERE / 'red.txt').read_text())['fail'] == 1
assert tap((HERE / 'focused.txt').read_text())['fail'] == 0
result = {'source_unchanged': True, 'runs': []}
for run in receipt['runs']:
    log = Path(run['log'])
    assert hashlib.sha256(log.read_bytes()).hexdigest() == run['log_sha256']
    text = log.read_text(encoding='utf-8')
    row = {'suite': run['suite'], 'exit_code': run['exit_code']}
    if run['suite'].endswith('bridge'):
        files = re.findall(r'^\[run-all\] node (tests[^\r\n]+) \([\d.]+s\)', text, re.M)
        failures = re.findall(r'^  - (tests[^\r\n]+) \(exit -?\d+\)', text, re.M)
        declared, = re.findall(r'^\[run-all\] (\d+) suite\(s\) FAILED:', text, re.M)
        assert len(files) == len(set(files)) and len(files) > 0
        assert len(failures) == int(declared)
        assert all(file in files for file in failures)
        row.update(file_invocations=len(files), unique_files=len(set(files)), failed_files=failures)
    elif run['suite'].endswith('python'):
        match, = re.findall(r'^(\d+) passed, (\d+) skipped, (\d+) warnings, (\d+) subtests passed', text, re.M)
        row.update(dict(zip(('passed', 'skipped', 'warnings', 'subtests_passed'), map(int, match))))
    else:
        row['reporter'] = tap(text)
    row['failed_case_or_file_labels'] = re.findall(r'^\s*not ok \d+ - (.+)$', text, re.M)
    result['runs'].append(row)
result['focused'] = tap((HERE / 'focused.txt').read_text())
result['native_cli_in_full_wrapper'] = bool(re.search(r'^ok \d+ - a denied Windows policy write[^\r\n]*$',
    (HERE / 'full/candidate-wrapper.txt').read_text(), re.M))
assert result['native_cli_in_full_wrapper']
result['named_env_controls'] = {}
for arm in ('baseline', 'candidate'):
    result['named_env_controls'][arm] = tap((HERE / 'named-env-control' / (arm + '.txt')).read_text())
(HERE / 'full/parsed-results.json').write_text(json.dumps(result, indent=2), encoding='utf-8', newline='\n')
print(json.dumps(result, indent=2))
