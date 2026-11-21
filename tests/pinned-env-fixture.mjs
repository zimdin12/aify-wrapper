import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fixtures that copy wrapper modules must carry their exact installed dependency, not search globally. */
export function includePinnedEnv(wrapper) {
  const source = path.dirname(fileURLToPath(import.meta.resolve('aify-env/package.json')));
  fs.cpSync(source, path.join(wrapper, 'node_modules', 'aify-env'), { recursive: true });
}
