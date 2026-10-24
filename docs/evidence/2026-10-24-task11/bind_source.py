import subprocess,hashlib,json
from pathlib import Path
root=Path.cwd()
base='e103f3d6dbfe0173352671eb76642a575b05cdd8'
tree='0d076ece4df68f0dd7c62326174000e130f1b626'
def git(*args): return subprocess.check_output(['git',*args])
assert git('write-tree').decode().strip()==tree
paths=git('diff','--cached','--name-only','-z').decode().strip('\0').split('\0')
assert len(paths)==5
payload={p:{'sha256':hashlib.sha256((root/p).read_bytes()).hexdigest(),'bytes':(root/p).stat().st_size} for p in paths}
for p in paths: assert (root/p).read_bytes()==git('show',f'{tree}:{p}')
policy='lib/channel-policy.mjs'
old=git('show',f'{base}:{policy}'); new=(root/policy).read_bytes()
anchor=b'import { spawnSync }'
old_code=old[old.index(anchor):]; new_code=new[new.index(anchor):]
assert old_code==new_code
assert old_code!=new_code+b' mutation'
print(json.dumps({'base':base,'source_tree':tree,'payload_files':len(paths),'payload':payload,'raw_worktree_equals_index':True,'policy_code_after_header_byte_identical':True,'policy_byte_comparison_negative_control':True},indent=2))
