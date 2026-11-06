import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export type Sop = { version: string; hash: string; documents: Record<string, string> };
export function loadSop(agent = false): Sop {
  const files = agent ? ['SOP.md', 'runtime.md'] : ['SOP.md', 'capture.md', 'score.md'];
  const version = agent ? 'agent-site-ui-v1' : 'site-ui-v1';
  const documents = Object.fromEntries(files.map(name => [name, readFileSync(resolve('sop', version, name), 'utf8')]));
  const hash = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
  return { version, hash, documents };
}
