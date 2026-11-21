// Read the source checkout's npm receipts without invoking npm or resolving from an ancestor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pathIn = name => path.join(root, name);
const read = name => JSON.parse(fs.readFileSync(pathIn(name), 'utf8'));
const dep = 'node_modules/aify-env';
const fullGitPin = /^git\+(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)zimdin12\/aify-env\.git#([\da-f]{40})$/;

function expected() {
  const declared = read('package.json').dependencies?.['aify-env'];
  const lock = read('package-lock.json').packages;
  const want = lock?.[dep];
  const sha = fullGitPin.exec(declared)?.[1];
  if (!sha || lock?.['']?.dependencies?.['aify-env'] !== declared || !want?.version || !want.integrity
      || fullGitPin.exec(want.resolved)?.[1] !== sha) throw new Error('aify-env pin in package.json and package-lock.json does not agree');
  return { version: want.version, sha };
}

function installedMatches({ version, sha }) {
  try {
    const info = read('node_modules/.package-lock.json').packages?.[dep];
    const pkg = read(`${dep}/package.json`);
    if (!fs.lstatSync(pathIn(dep)).isDirectory() || pkg.name !== 'aify-env' || pkg.version !== version
        || info?.version !== version || fullGitPin.exec(info.resolved)?.[1] !== sha) return false;
    return ['credentials', 'machine-id'].every(name => {
      const leaf = pkg.exports?.[`./client/${name}`]?.default;
      return leaf === `./lib/client/${name}.mjs` && fs.statSync(pathIn(`${dep}/${leaf}`)).isFile();
    });
  } catch {
    return false;
  }
}

try {
  process.exitCode = installedMatches(expected()) ? 0 : 1;
} catch (error) {
  console.error(`install.sh: cannot verify the aify-env lock: ${error.message}`);
  process.exitCode = 78;
}
