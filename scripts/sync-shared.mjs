#!/usr/bin/env node
/**
 * The data contracts and geometry in backend/src/shared/ are the source of
 * truth. frontend/src/shared/ is a copy so each folder installs and deploys on
 * its own. Edit the backend copy, then run `npm run sync-shared`.
 *   --check  exit 1 if the copies differ (use in CI)
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'backend/src/shared');
const dst = join(root, 'frontend/src/shared');
const check = process.argv.includes('--check');
const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
const stale = files.filter((f) => {
  try {
    return readFileSync(join(src, f), 'utf8') !== readFileSync(join(dst, f), 'utf8');
  } catch {
    return true;
  }
});
if (check) {
  if (stale.length) {
    console.error(`frontend/src/shared is out of date: ${stale.join(', ')}. Run: npm run sync-shared`);
    process.exit(1);
  }
  console.log('shared code in sync');
} else {
  mkdirSync(dst, { recursive: true });
  for (const f of files) copyFileSync(join(src, f), join(dst, f));
  console.log(`copied ${files.length} files to frontend/src/shared`);
}
