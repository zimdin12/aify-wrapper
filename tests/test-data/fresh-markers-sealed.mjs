// The Reset caller may touch owned markers, never start runtimes or use the network.
import net from "node:net";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const refuse = () => { throw new Error("FORBIDDEN: Reset cleanup attempted network or spawn"); };
for (const name of ["connect", "createConnection", "createServer"]) net[name] = refuse;
net.Socket.prototype.connect = refuse;
for (const module of [http, https]) for (const name of ["request", "get", "createServer"]) module[name] = refuse;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = refuse;
globalThis.fetch = refuse;
globalThis.WebSocket = class { constructor() { refuse(); } };
syncBuiltinESMExports();
