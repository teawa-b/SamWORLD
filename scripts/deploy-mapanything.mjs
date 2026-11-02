#!/usr/bin/env node
/**
 * Deploy the Roomshift MapAnything GPU worker to Modal and connect the backend to it.
 *
 *   python -m modal setup              (once: logs this machine into your Modal account)
 *   node scripts/deploy-mapanything.mjs
 *
 * Steps: reads MAPANYTHING_TOKEN from backend/.env (creates one if missing) → stores it as the Modal secret
 * `roomshift-auth` → `modal deploy worker-3d/mapanything_app.py` → writes the printed URL + /reconstruct to
 * MAPANYTHING_URL in backend/.env → checks /health (this wakes the GPU once; it scales back to zero after 2 min).
 * Restart the backend afterwards so it picks up the new .env.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, 'backend', '.env');
const py = process.platform === 'win32' ? 'python' : 'python3';

function setEnv(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`;
}

function run(args, { secret } = {}) {
  return new Promise((resolve, reject) => {
    const shown = secret ? args.map((a) => a.replace(secret, '***')) : args;
    console.log(`\n> ${py} ${shown.join(' ')}`);
    const p = spawn(py, args, { cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    const tee = (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(secret ? s.replaceAll(secret, '***') : s);
    };
    p.stdout.on('data', tee);
    p.stderr.on('data', tee);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(join(root, 'backend', '.env.example'), 'utf8');
let token = /^MAPANYTHING_TOKEN=(\S+)/m.exec(env)?.[1];
if (!token) {
  token = randomBytes(24).toString('hex');
  env = setEnv(env, 'MAPANYTHING_TOKEN', token);
  writeFileSync(envPath, env);
  console.log('Created MAPANYTHING_TOKEN in backend/.env');
}

try {
  await run(['-m', 'modal', 'token', 'info']).catch(() => {
    throw new Error('Modal is not logged in on this machine. Run:  python -m modal setup   then run this script again.');
  });
  await run(['-m', 'modal', 'secret', 'create', 'roomshift-auth', `ROOMSHIFT_AUTH_TOKEN=${token}`, '--force'], { secret: token });
  console.log('\nDeploying. The first build installs PyTorch + MapAnything and downloads the weights: allow 10–20 minutes.');
  const out = await run(['-m', 'modal', 'deploy', 'worker-3d/mapanything_app.py']);
  const base = /https:\/\/[\w.-]+\.modal\.run/.exec(out)?.[0];
  if (!base) throw new Error('Deployed, but no https://….modal.run URL was printed. Find it on modal.com (app "roomshift-mapanything") and set MAPANYTHING_URL=<url>/reconstruct in backend/.env.');
  env = setEnv(readFileSync(envPath, 'utf8'), 'MAPANYTHING_URL', `${base}/reconstruct`);
  writeFileSync(envPath, env);
  console.log(`\nbackend/.env: MAPANYTHING_URL=${base}/reconstruct`);

  console.log('\nWaking the GPU once to check it works (cold start: up to ~2 minutes)…');
  const t = Date.now();
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(300_000) });
  const body = await res.text();
  console.log(`/health → HTTP ${res.status} in ${((Date.now() - t) / 1000).toFixed(0)} s: ${body.slice(0, 300)}`);
  if (!res.ok) throw new Error('The worker deployed but /health failed; see `python -m modal app logs roomshift-mapanything`.');
  console.log('\nDone. Restart the backend (npm run dev:backend) so it reads the new MAPANYTHING_URL.');
  console.log('To stop all GPU billing at any time:  python -m modal app stop roomshift-mapanything');
} catch (e) {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
}
