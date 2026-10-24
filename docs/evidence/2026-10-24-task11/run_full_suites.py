"""One task-11 five-suite campaign, using the existing gate layout and matched controls."""
import ctypes
from ctypes import wintypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

WRAPPER = Path(__file__).resolve().parents[3]
BASE_WRAPPER = WRAPPER.with_name('aify-wrapper')
ENV = WRAPPER.with_name('aify-env')
COMMS = WRAPPER.with_name('aify-comms-task5')
OUT = Path(__file__).resolve().parent / 'full'
SCRATCH = Path('C:/Users/Administrator/AppData/Local/hermes/cache/scratch/task11-full')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def source_state():
    result = {}
    for name, root in [('candidate_wrapper', WRAPPER), ('baseline_wrapper', BASE_WRAPPER), ('env', ENV), ('comms', COMMS)]:
        paths = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).split(b'\0')
        digest = hashlib.sha256()
        for raw in sorted(p for p in paths if p):
            data = (root / raw.decode('utf-8')).read_bytes()
            digest.update(raw + b'\0' + hashlib.sha256(data).digest())
        result[name] = {'path': str(root), 'head': git(root, 'rev-parse', 'HEAD'),
                        'tracked_files': len([p for p in paths if p]), 'raw_population_sha256': digest.hexdigest()}
    result['candidate_staged_tree'] = git(WRAPPER, 'write-tree')
    return result


def current_process_birth():
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *[ctypes.POINTER(wintypes.FILETIME)] * 4]
    times = [wintypes.FILETIME() for _ in range(4)]
    if not kernel.GetProcessTimes(kernel.GetCurrentProcess(), *[ctypes.byref(t) for t in times]):
        raise ctypes.WinError(ctypes.get_last_error())
    return {'pid': os.getpid(), 'creation_filetime_100ns': (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime}


class SuiteCampaign:
    def run(self):
        OUT.mkdir(exist_ok=False)
        SCRATCH.mkdir(exist_ok=True)
        node, bash = shutil.which('node'), shutil.which('bash')
        assert node and bash
        env = dict(os.environ, AIFY_ENV_REPO=str(ENV), TMPDIR=str(SCRATCH), TEMP=str(SCRATCH), TMP=str(SCRATCH),
                   AIFY_SHADOW_PYTHON=sys.executable, PYTHONPATH=os.pathsep.join(sys.path))
        for key in list(env):
            if key.upper() in ('MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL'):
                del env[key]
        receipt = {'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'coordinator': current_process_birth(),
                   'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   'before': source_state(), 'python': sys.executable, 'node': node, 'shell': bash,
                   'pins': {key: env.get(key) for key in ('TMPDIR', 'TEMP', 'TMP', 'PYTHONPATH', 'AIFY_SHADOW_PYTHON',
                             'AIFY_ENV_REPO', 'MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL')}, 'runs': []}
        suites = [
            ('baseline-bridge', COMMS / 'mcp/stdio', [node, 'tests/run-all.mjs']),
            ('baseline-env', ENV, [bash, '-c', 'npm test']),
            ('candidate-python', COMMS, [sys.executable, '-m', 'pytest', 'service/tests', 'scripts/tests', '-q', '-n', '8', '--dist', 'loadfile']),
            ('candidate-bridge', COMMS / 'mcp/stdio', [node, 'tests/run-all.mjs']),
            ('candidate-dashboard', COMMS / 'service/new_dashboard', [node, '--test', *sorted(p.name for p in (COMMS / 'service/new_dashboard').glob('*.test.mjs'))]),
            ('candidate-wrapper', WRAPPER, [bash, '-c', 'npm test']),
            ('candidate-env', ENV, [bash, '-c', 'npm test']),
        ]
        target = OUT / 'receipt.json'
        target.write_text(json.dumps(receipt, indent=2), encoding='utf-8', newline='\n')
        for name, cwd, command in suites:
            wrapper = BASE_WRAPPER if name.startswith('baseline-') else WRAPPER
            child_env = dict(env, AIFY_WRAPPER_REPO=str(wrapper))
            log = OUT / f'{name}.txt'
            print('START', name, flush=True)
            started = time.monotonic()
            with log.open('xb') as stream:
                completed = subprocess.run(command, cwd=cwd, env=child_env, stdout=stream, stderr=subprocess.STDOUT)
            receipt['runs'].append({'suite': name, 'cwd': str(cwd), 'command': command, 'wrapper_repo': str(wrapper),
                                    'exit_code': completed.returncode, 'elapsed_s': round(time.monotonic() - started, 3),
                                    'log': str(log), 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()})
            target.write_text(json.dumps(receipt, indent=2), encoding='utf-8', newline='\n')
            print('END', name, 'exit=' + str(completed.returncode), flush=True)
        receipt['after'] = source_state()
        receipt['source_unchanged'] = receipt['before'] == receipt['after']
        receipt['candidate_all_five_passed'] = all(r['exit_code'] == 0 for r in receipt['runs'] if r['suite'].startswith('candidate-'))
        target.write_text(json.dumps(receipt, indent=2), encoding='utf-8', newline='\n')
        print('COMPLETE source_unchanged=' + str(receipt['source_unchanged']) + ' candidate_all_five_passed=' + str(receipt['candidate_all_five_passed']), flush=True)
        return 0 if receipt['source_unchanged'] and receipt['candidate_all_five_passed'] else 1


if __name__ == '__main__':
    raise SystemExit(SuiteCampaign().run())
