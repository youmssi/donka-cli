import { mkdtempSync, rmSync, globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { reportCoverage } from './coverage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const raw = mkdtempSync(join(tmpdir(), 'donka-cli-v8-'));
try {
  const tests = spawnSync(process.execPath, ['--test', ...globSync('test/**/*.test.ts', { cwd: root })], {
    cwd: root,
    env: { ...process.env, NODE_V8_COVERAGE: raw },
    stdio: 'inherit',
  });
  if (tests.error) throw tests.error;
  if (tests.status !== 0) process.exitCode = tests.status ?? 1;
  else await reportCoverage(root, raw, resolve(root, 'coverage'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(raw, { recursive: true, force: true });
}
