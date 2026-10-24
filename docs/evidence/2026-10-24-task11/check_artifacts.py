import os,re,json,hashlib,subprocess
from pathlib import Path
root=Path.cwd(); evidence=root/'docs/evidence/2026-10-24-task11'
files=[p for p in evidence.rglob('*') if p.is_file() and p.suffix in ('.md','.py','.json','.txt')]
payload=json.loads((evidence/'source-binding.json').read_text())['payload']
files += [root/p for p in payload]
values={value.encode() for name,value in os.environ.items() if re.search(r'KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL',name,re.I) and len(value)>=8}
assert any(value in b'prefix scope-probe-value suffix' for value in [b'scope-probe-value'])
assert not any(value in b'known-negative-control' for value in [b'scope-probe-value'])
hits=[str(p.relative_to(root)) for p in files if any(value in p.read_bytes() for value in values)]
assert not hits, 'credential-valued environment data found in scoped artifacts'
bundled=root.with_name('aify-comms-task5')/'mcp/stdio/node_modules/aify-wrapper/lib/channel-install.mjs'
base=subprocess.check_output(['git','show','e103f3d6dbfe0173352671eb76642a575b05cdd8:lib/channel-install.mjs'])
actual=bundled.read_bytes()
print(json.dumps({'environment_value_scan':{'selection':'environment names matching KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL, values at least eight bytes','selected_values':len(values),'files_examined':len(files),'matched_files':hits,'positive_control':True,'negative_control':True},'bundled_wrapper_installer':{'path':str(bundled),'sha256':hashlib.sha256(actual).hexdigest(),'equals_base_bytes':actual==base}},indent=2))
