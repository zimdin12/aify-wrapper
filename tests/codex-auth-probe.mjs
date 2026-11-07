// Codex-owned observations over the maintained render/home fixture; its generic API/listener stay unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {launch} from './launch-to-a-stub-runtime.mjs';
import {READER_FILES} from './definition-reader-wrapper.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath.replaceAll('\\', '/');
const MINT = 'lib/codex-app-server-auth.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const LISTENER = `const fs=require("fs"),path=require("path"),net=require("net"),crypto=require("crypto");
const dir=path.join(process.env.HOME,".aify/sessions/codex-auth-probe");
fs.mkdirSync(dir,{recursive:true});
const port=Number(process.argv[2].split(":").pop());
const server=net.createServer(socket=>{socket.on("error",()=>{});socket.end();});
setTimeout(()=>server.listen(port,"127.0.0.1",()=>{
  const tokenSha256=crypto.createHash("sha256").update(process.env.AIFY_CODEX_APP_SERVER_TOKEN||"").digest("hex");
  fs.writeFileSync(path.join(dir,"listener.json"),JSON.stringify({pid:process.pid,port,tokenSha256}));
}),Number(process.env.AUTH_LISTEN_DELAY_MS||0));
setTimeout(()=>process.exit(0),30000).unref();`;

const RECORDER = `import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {createHash} from 'node:crypto';
const [role,...argv]=process.argv.slice(2);
const token=process.env.AIFY_CODEX_APP_SERVER_TOKEN||'',pointer=process.env.AIFY_CODEX_REMOTE_AUTH_TOKEN_ENV;
const digest=value=>createHash('sha256').update(value).digest('hex');
const dir=path.join(process.env.HOME,'.aify/sessions/codex-auth-probe');
const manifest=JSON.parse(fs.readFileSync(path.join(process.env.AUTH_WORLD,'auth-fixture-manifest.json'),'utf8'));
const inputsAfter=Object.fromEntries(Object.keys(manifest.inputsBefore).map(file=>[file,fs.existsSync(file)?digest(fs.readFileSync(file)):null]));
const logs=path.join(process.env.AUTH_WORLD,'state/aify-comms');
const logLeak=!!token&&fs.existsSync(logs)&&fs.readdirSync(logs).some(file=>fs.readFileSync(path.join(logs,file),'utf8').includes(token));
let registration=null;
if(role==='app-server'&&process.env.AUTH_REGISTRATION_MODULE){
  const {resolvedRuntimeConfigForRegistration:resolve}=await import(process.env.AUTH_REGISTRATION_MODULE);
  const current=resolve('codex',null,process.env.AUTH_WORLD);
  delete process.env.AIFY_CODEX_REMOTE_AUTH_TOKEN_ENV;
  const unnamed=resolve('codex',null,process.env.AUTH_WORLD);
  if(pointer!==undefined)process.env.AIFY_CODEX_REMOTE_AUTH_TOKEN_ENV=pointer;
  registration={current,unnamed,containsRawToken:!!token&&JSON.stringify(current).includes(token)};
}
let listener=null;
const listenerFile=path.join(dir,'listener.json');
if(fs.existsSync(listenerFile)){
  const identity=JSON.parse(fs.readFileSync(listenerFile,'utf8'));
  let live;
  try{process.kill(identity.pid,0);live=true;}
  catch(error){if(error.code!=='ESRCH')throw error;live=false;}
  const reachable=await new Promise(resolve=>{
    const connection=net.createConnection({host:'127.0.0.1',port:identity.port});
    let done=false;
    const finish=value=>{if(done)return;done=true;connection.destroy();resolve(value);};
    connection.setTimeout(1000,()=>finish(false));
    connection.on('connect',()=>finish(true));connection.on('error',()=>finish(false));
  });
  listener={...identity,live,reachable};
}
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,role+'.json'),JSON.stringify({
  registration,listener,argv,
  token:{present:!!token,valid:/^[A-Za-z0-9_-]{43}$/.test(token),sha256:token?digest(token):null},
  pointer:{present:pointer!==undefined,value:pointer},
  digestEnvPresent:Object.hasOwn(process.env,'AIFY_CODEX_APP_SERVER_TOKEN_SHA256'),
  argvLeak:!!token&&argv.some(value=>value.includes(token)),logLeak,inputsAfter
}));`;

const WAIT_OBSERVER = `const fs=require("fs"),p=require("path"),cp=require("child_process"),start=Date.now();
const dir=p.join(process.env.HOME,".aify/sessions/codex-auth-probe");
fs.mkdirSync(dir,{recursive:true});
let attempts=0,childStarts=0;
function record(){
  const packet=JSON.stringify({elapsedMs:Date.now()-start,jobPid:Number(process.argv[2]),observerPid:process.pid,
    subshellDepth:process.env.AUTH_WAIT_SUBSHELL??null,attempts,childStarts});
  fs.writeFileSync(p.join(dir,"wait.json"),packet);
  fs.writeFileSync(p.join(dir,"wait-"+process.pid+".json"),packet);
}
for(const method of ["spawn","spawnSync","exec","execSync","execFile","execFileSync","fork"]){
  const original=cp[method];
  cp[method]=function(...args){childStarts++;record();return Reflect.apply(original,this,args);};
}
const connect=require("net").createConnection;
require("net").createConnection=function(...args){attempts++;record();return Reflect.apply(connect,this,args);};
record();process.on("exit",record);`;

function observations({result, fixtureBefore}) {
  const packet = role => {
    const text = result.sessionFiles['codex-auth-probe/' + role + '.json'];
    return text ? JSON.parse(text) : null;
  };
  const token = result.appServerEnv.AIFY_CODEX_APP_SERVER_TOKEN || result.started.AIFY_CODEX_APP_SERVER_TOKEN || '';
  const secretLeak = !!token && (result.run.stdout.includes(token) || result.run.stderr.includes(token));
  const observed = {...result, fixtureBefore, server: packet('app-server'), tui: packet('tui'),
    host: packet('host'), wait: packet('wait'), setsid: packet('setsid'), secretLeak};
  // Assertion diffs must never print a leaked capability, even from an intentionally broken producer.
  return token ? JSON.parse(JSON.stringify(observed).split(token).join('<redacted-capability>')) : observed;
}

export class CodexAuthProbe {
  constructor({missingHelper = false, host = false, forceNoSetsid = false, xtrace = false,
    serverMode = 'supported', tuiReject = false} = {}) {
    Object.assign(this, {missingHelper, host, forceNoSetsid, xtrace, serverMode, tuiReject});
  }

  run({args = [], environment = {}, files: extraFiles = {}, edit} = {}) {
    const files = this.fixtureFiles(extraFiles);
    let fixtureBefore;
    // Existing fixture callbacks run after generated launchers/stubs exist, outside HOME/session effects.
    files['auth-fixture-manifest.json'] = context => {
      fixtureBefore = this.inputManifest(context, extraFiles);
      return JSON.stringify(fixtureBefore);
    };
    const result = launch('codex', args, {
      reader: !this.missingHelper, files,
      env: {AUTH_WORLD: ({dir}) => dir.replaceAll('\\', '/'), XDG_STATE_HOME: ({dir}) => path.join(dir, 'state'),
        AUTH_SERVER_MODE: this.serverMode, AUTH_TUI_REJECT: this.tuiReject ? '1' : '0', ...environment},
      edit: text => this.watchedLauncher({text, edit}),
    });
    return observations({result, fixtureBefore});
  }

  fixtureFiles(extraFiles) {
    const files = {'auth-recorder.mjs': RECORDER, 'auth-wait-observer.cjs': WAIT_OBSERVER, 'auth-listener.cjs': LISTENER};
    if (this.missingHelper) {
      for (const file of READER_FILES.filter(file => file !== MINT)) files['wrapper/' + file] = fs.readFileSync(path.join(ROOT, file));
    }
    files['stubs/codex'] = context => this.codexStub(context);
    files['stubs/setsid'] = {mode: 0o755, text: `#!/bin/bash
mkdir -p "$HOME/.aify/sessions/codex-auth-probe"
printf '{}\\n' > "$HOME/.aify/sessions/codex-auth-probe/setsid.json"
exec "$@"
`};
    if (this.host) files['stubs/aify-env'] = {mode: 0o755, text: `#!/bin/bash
"${NODE}" "$AUTH_WORLD/auth-recorder.mjs" host "$@" || exit $?
if [ "\${AUTH_HOST_RELAUNCH:-0}" = 1 ]; then
  unset AUTH_HOST_RELAUNCH
  launcher=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --launcher) launcher="$2"; shift 2 ;;
      --) shift; break ;;
      *) shift ;;
    esac
  done
  [ -n "$launcher" ] || exit 92
  exec "$launcher" "$@"
fi
`};
    return Object.assign(files, extraFiles);
  }

  codexStub({dir}) {
    let text = fs.readFileSync(path.join(dir, 'stubs/codex'), 'utf8');
    const recorder = `"${NODE}" "$AUTH_WORLD/auth-recorder.mjs"`;
    const serverRecord = '  env > "$STUB_RUNTIME_ENV.app-server-env"';
    if (text.split(serverRecord).length !== 2) throw new Error('owned app-server recorder site changed');
    text = text.replace(serverRecord, () => serverRecord + '\n  ' + recorder + ' app-server "$@"\n' + [
      '  if [ "${AUTH_INJECT_LOG_LEAK:-0}" = 1 ]; then printf "%s\\n" "${AIFY_CODEX_APP_SERVER_TOKEN:-}" >&2; fi',
      '  case "$AUTH_SERVER_MODE" in',
      '    reject-ws-auth) for flag in "$@"; do if [ "$flag" = --ws-auth ]; then echo "error: unexpected argument \'--ws-auth\' found" >&2; exit 64; fi; done ;;',
      '    reject-sha256) for flag in "$@"; do if [ "$flag" = --ws-token-sha256 ]; then echo "error: unexpected argument \'--ws-token-sha256\' found" >&2; exit 64; fi; done ;;',
      '    die-non-auth) echo "error: owned transport initialization failed" >&2; exit 63 ;;',
      '    error-mentions-auth) echo "error: owned disk failure while saving --ws-auth diagnostics" >&2; exit 63 ;;',
      '  esac',
    ].join('\n'));
    const runtimeRecord = 'env > "$STUB_RUNTIME_ENV"';
    if (text.split(runtimeRecord).length !== 2) throw new Error('owned TUI recorder site changed');
    text = text.replace(runtimeRecord, () => runtimeRecord + '\n' + recorder + ' tui "$@"\n' +
      'if [ "$AUTH_TUI_REJECT" = 1 ]; then for flag in "$@"; do if [ "$flag" = --remote-auth-token-env ]; then echo "error: unexpected argument \'--remote-auth-token-env\' found" >&2; exit 62; fi; done; fi');
    // Replace this new probe's listener only, preserving the shared fixture's bytes and API.
    const lines = text.split('\n');
    const site = lines.findIndex(line => line.includes('exec ') && line.includes('require("net").createServer'));
    if (site < 0) throw new Error('owned listener execution site changed');
    lines[site] = `  exec "${NODE}" "$AUTH_WORLD/auth-listener.cjs" "$url"`;
    return lines.join('\n');
  }

  inputManifest({dir, home}, extraFiles) {
    const names = ['out/codex-aify', 'stubs/codex', 'stubs/setsid', 'auth-recorder.mjs', 'auth-wait-observer.cjs',
      'auth-listener.cjs', 'wrapper/' + MINT, ...(this.host ? ['stubs/aify-env'] : []),
      ...Object.keys(extraFiles).map(file => file.replace(/^<home>/, path.relative(dir, home)))];
    const inputsBefore = Object.fromEntries(names.map(file => {
      const full = path.join(dir, file);
      return [full, fs.existsSync(full) ? sha(fs.readFileSync(full)) : null];
    }));
    return {inputsBefore, missingControl: fs.existsSync(path.join(dir, 'no-such-auth-input-control'))};
  }

  watchedLauncher({text, edit}) {
    let body = text;
    const from = body.indexOf('wait_for_port() {'), to = body.indexOf('\nCODEX_AUTO=', from);
    if (from < 0 || to < from) throw new Error('actual readiness function boundary changed');
    const original = body.slice(from, to), needle = 'const net = require("net");';
    if (original.split(needle).length !== 2) throw new Error('owned readiness Node observation site changed');
    const watched = original.replace(needle, () => needle + '\n    require(process.env.AUTH_WORLD+"/auth-wait-observer.cjs");');
    body = body.slice(0, from) + watched + body.slice(to);
    if (this.forceNoSetsid) {
      const branch = 'if command -v setsid >/dev/null 2>&1; then';
      if (body.split(branch).length !== 2) throw new Error('owned setsid branch changed');
      body = body.replace(branch, 'if false; then');
    }
    const newline = body.indexOf('\n');
    body = body.slice(0, newline + 1) + (this.xtrace ? 'set -x\n' : '') +
      '_auth_stubs="$(cd "$AUTH_WORLD/stubs" && pwd)"\nexport PATH="$_auth_stubs:$PATH"\n' +
      '[ "$(command -v codex)" = "$_auth_stubs/codex" ] || exit 91\n' + body.slice(newline + 1);
    return edit ? edit(body) : body;
  }
}
