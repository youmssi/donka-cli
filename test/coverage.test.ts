import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'node:test';
import { build } from 'rolldown';
import { reportCoverage, sourceIncluded } from '../scripts/coverage.mjs';

it('source filtering accepts file URLs and filesystem paths without accepting dependencies', () => {
  const root = join(tmpdir(), 'donka-coverage-source');
  const path = join(root, 'src', 'form.ts');
  assert.equal(sourceIncluded(pathToFileURL(path).href, root), true);
  assert.equal(sourceIncluded(path, root), true);
  assert.equal(sourceIncluded(join(root, 'node_modules', 'src', 'other.ts'), root), false);
  assert.equal(sourceIncluded(join(root, 'src', 'global.d.ts'), root), false);
});

it('the report remaps a called function and keeps an uncalled function uncovered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donka-coverage-proof-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'sample.ts'),
      [
        'export function called(value: number) {',
        '  return value + 1;',
        '}',
        'export function uncalled(value: number) {',
        '  return value + 2;',
        '}',
        'console.log(called(1));',
      ].join('\n'),
    );
    writeFileSync(join(root, 'src', 'never-imported.ts'), 'export function neverImported() { return 1; }\n');
    await build({
      input: join(root, 'src', 'sample.ts'),
      output: { file: join(root, 'dist', 'sample.mjs'), format: 'esm', sourcemap: true },
    });
    const raw = join(root, 'raw');
    execFileSync(process.execPath, [join(root, 'dist', 'sample.mjs')], {
      env: { ...process.env, NODE_V8_COVERAGE: raw },
    });
    const output = join(root, 'coverage');
    // Untested functions, including an unimported file, must keep this fixture below the floor.
    await assert.rejects(reportCoverage(root, raw, output), /below 70%/);
    const lcov = readFileSync(join(output, 'lcov.info'), 'utf8');
    assert.match(lcov, /FNDA:1,called/);
    assert.match(lcov, /FNDA:0,uncalled/);
    assert.match(lcov, /FNDA:0,neverImported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
