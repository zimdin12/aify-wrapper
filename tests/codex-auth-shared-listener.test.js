// Qualify the maintained generated stub, not a replacement listener. errorMonitor observes without handling errors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {launch} from './launch-to-a-stub-runtime.mjs';

const OBSERVER = `const fs=require("fs"),path=require("path"),observedNet=require("net"),monitor=require("events").errorMonitor;
const root=process.env.SOCKET_FIXTURE_ROOT,events=path.join(root,"events.ndjson");
const record=data=>fs.appendFileSync(events,JSON.stringify({pid:process.pid,...data})+"\\n");
const create=observedNet.createServer;
observedNet.createServer=function(...args){
 const server=Reflect.apply(create,this,args);
 server.on("listening",()=>record({kind:"listening",port:server.address().port}));
 server.on(monitor,error=>record({kind:"server-error",code:error.code}));
 server.on("connection",socket=>{
  record({kind:"accepted",port:socket.remotePort});
  socket.on(monitor,error=>record({kind:"socket-error",code:error.code}));
 });
 return server;
};
setInterval(()=>{if(fs.existsSync(path.join(root,"stop")))process.exit(0);},25).unref();
setTimeout(()=>process.exit(0),5000).unref();`;

const sourceFingerprint = ({file, bytes}) => ({file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});

async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}
async function closeByDeadline(closed) {
  let timer;
  try {
    return await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('owned listener failed its6s closure deadline')), 6000);
    })]);
  } finally { clearTimeout(timer); }
}
class GeneratedListener {
  constructor(t, {program} = {}) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-codex-socket-'));
    this.home = path.join(this.root, 'home');fs.mkdirSync(this.home);
    if (program === undefined) {
      const source = launch('codex', ['--check'], {files: {
        '<home>/.aify/sessions/generated-stub.sh': ({dir}) => fs.readFileSync(path.join(dir, 'stubs/codex')),
      }});
      assert.equal(source.run.status, 0, source.run.stderr);
      const stub = source.sessionFiles['generated-stub.sh'];
      assert.equal(stub.split('require("net").createServer').length, 2);
      this.script = path.join(this.root, 'generated-codex.sh');
      fs.writeFileSync(this.script, stub.replace('require("net").createServer', () => OBSERVER + 'require("net").createServer'), {mode: 0o755});
    } else {
      this.script = path.join(this.root, 'actual-shared-listener.mjs');
      fs.writeFileSync(this.script, 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);\n' + OBSERVER + program);
    }
    t.after(async () => {
      if (this.run) {
        fs.writeFileSync(path.join(this.root, 'stop'), 'owned stop');
        const terminal = await closeByDeadline(this.run.closed);
        assert.deepEqual(terminal.sourceAfter, terminal.sourceBefore, 'executed generated listener bytes changed');
        console.log('AIFY_EXECUTED_LISTENER_AFTER', JSON.stringify(terminal.sourceAfter));
      }
      fs.rmSync(this.root, {recursive: true, force: true});
    });
  }
  start({port}) {
    const env = {PATH: process.env.PATH, ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {}),
      HOME: this.home, USERPROFILE: this.home, TEMP: this.root, TMP: this.root, TMPDIR: this.root,
      STUB_RUNTIME_ENV: path.join(this.root, 'runtime-env'), SOCKET_FIXTURE_ROOT: this.root};
    const url = 'ws://127.0.0.1:' + port;
    const [executable, args] = this.script.endsWith('.mjs')
      ? [process.execPath, [this.script, url]] : ['bash', [this.script, 'app-server', '--listen', url]];
    const bytes = fs.readFileSync(this.script), sourceBefore = sourceFingerprint({file: this.script, bytes});
    console.log('AIFY_EXECUTED_LISTENER_BEFORE', JSON.stringify({...sourceBefore, base64: bytes.toString('base64')}));
    const child = spawn(executable, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';child.stdout.on('data', bytes => { output += bytes; });child.stderr.on('data', bytes => { output += bytes; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject);child.once('close', (code, signal) =>
      resolve({code, signal, sourceBefore, sourceAfter: sourceFingerprint({file: this.script, bytes: fs.readFileSync(this.script)})})); });
    this.run = {child, closed, output: () => output};
    return this.run;
  }
  events() {
    const file = path.join(this.root, 'events.ndjson');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  }
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function connection(port, reset = false) {
  return await new Promise(resolve => {
    const socket = net.createConnection({host: '127.0.0.1', port});let localPort;
    const finish = ended => { socket.destroy();resolve({ended, localPort}); };
    socket.setTimeout(1000, () => finish(false));socket.on('error', () => finish(false));
    socket.on('connect', () => { localPort = socket.localPort;if (reset) { socket.resetAndDestroy();resolve({ended: false, localPort}); } });
    socket.on('end', () => finish(true));
  });
}

function standaloneSharedProgram() {
  const file = path.join(import.meta.dirname, 'shared-actually-reaches-the-host.test.js');
  const source = fs.readFileSync(file, 'utf8');
  const marker = 'fs.writeFileSync(path.join(bin, "app-server-stub.mjs"), ';
  assert.equal(source.split(marker).length, 2);
  const from = source.indexOf(marker) + marker.length, to = source.indexOf('].join(LF));', from) + 1;
  assert.ok(to > from);
  // The actual producer's static literal array, in an isolated context; not a hand-recreated listener.
  const lines = runInNewContext(source.slice(from, to), Object.create(null), {timeout: 100});
  assert.ok(Array.isArray(lines) && lines.every(line => typeof line === 'string'));
  return lines.join('\n');
}
const subjects = [
  {name: 'maintained generated helper', make: t => new GeneratedListener(t)},
  {name: 'standalone shared-host listener body', make: t => new GeneratedListener(t, {program: standaloneSharedProgram()})},
];
for (const subject of subjects) {
test(`${subject.name}: generated accepted-socket handler survives a witnessed RST and serves the next accepted connection`, async t => {
  const fixture = subject.make(t), reservation = net.createServer();
  const port = await listen(reservation);await new Promise(resolve => reservation.close(resolve));
  const run = fixture.start({port});
  await until(() => fixture.events().some(event => event.kind === 'listening'), 'owned generated listener must actually bind');
  await connection(port, true);
  await until(() => fixture.events().some(event => event.kind === 'socket-error' && event.code === 'ECONNRESET'), 'passive monitor must witness delivery of the forced reset');
  const next = await connection(port);
  const accepted = fixture.events().some(event => event.kind === 'accepted' && event.port === next.localPort);
  assert.deepEqual({ended: next.ended, accepted, closed: run.child.exitCode !== null},
    {ended: true, accepted: true, closed: false}, 'generated listener must survive reset and serve a subsequent accepted connection');
});

test(`${subject.name}: accepted-socket handler does not swallow a distinct server bind/startup failure`, async t => {
  const fixture = subject.make(t), occupied = net.createServer(socket => socket.end());
  const port = await listen(occupied);t.after(() => new Promise(resolve => occupied.close(resolve)));
  const control = await connection(port);assert.equal(control.ended, true, 'positive control: the owned occupier must serve its port');
  const run = fixture.start({port}), terminal = await closeByDeadline(run.closed);
  assert.deepEqual({code: terminal.code, bound: fixture.events().some(event => event.kind === 'listening'),
    bindError: fixture.events().some(event => event.kind === 'server-error' && event.code === 'EADDRINUSE')},
    {code: 1, bound: false, bindError: true}, run.output());
});
}
