import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve against the project root, so the result doesn't depend on the cwd.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['build', 'dist', 'node_modules']) {
  await rm(resolve(root, name), { recursive: true, force: true, maxRetries: 3 });
  console.log(`Removed ${name}`);
}
