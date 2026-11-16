import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PROJECT, STAGING, TOKEN, spawnAsync, startFakeStudio, type FakeStudio } from './fake-studio.ts';

const CLI = resolve(import.meta.dirname, '../dist/main.js');

let studio: FakeStudio;
before(async () => {
  studio = await startFakeStudio();
});
after(async () => {
  await studio.close();
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  out: string;
}

/** Runs the built CLI the way a pipeline does: settings in DONKA_* variables. */
const pull = async (args: string[], env: Record<string, string> = {}): Promise<Run> => {
  const out = mkdtempSync(join(tmpdir(), 'donka-pull-'));
  const result = await spawnAsync(process.execPath, [CLI, 'pull', '--out', out, ...args], {
    env: {
      PATH: process.env.PATH,
      DONKA_URL: studio.url,
      DONKA_TOKEN: TOKEN,
      DONKA_PROJECT: PROJECT.key,
      ...env,
    },
  });
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN), 'the token is never printed');
  return { ...result, out };
};

const summary = (run: Run) => JSON.parse(run.stdout) as Record<string, unknown>;

describe('donka pull', () => {
  it('pulls the newest release for main, checksum verified', async () => {
    const run = await pull(['--json']);
    assert.equal(run.code, 0, run.stderr);
    const result = summary(run);
    assert.equal(result.version, '1.1.0');
    assert.equal(result.commit, 'r-2');
    assert.equal(result.verified, true);
    assert.deepEqual(readdirSync(run.out), [PROJECT.key]);
  });

  it('pulls a release by its id with commit:', async () => {
    const run = await pull(['--json', '--target', 'commit:r-1']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(summary(run).version, '1.0.0');
  });

  it('pulls a release by its version with release:, with or without v', async () => {
    for (const target of ['release:1.0.0', 'release:v1.1.0']) {
      const run = await pull(['--json'], { DONKA_TARGET: target });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(summary(run).version, target.endsWith('1.0.0') ? '1.0.0' : '1.1.0');
    }
  });

  it('pulls what is live on an environment with env:, unpacked', async () => {
    const run = await pull(['--json', '--target', 'env:staging', '--unpack', '--name', '.']);
    assert.equal(run.code, 0, run.stderr);
    const result = summary(run);
    assert.equal(result.environment, 'staging');
    assert.equal(result.commit, STAGING.deployment);
    const manifest = JSON.parse(readFileSync(join(run.out, '.config/project.json'), 'utf-8')) as object;
    assert.deepEqual(manifest, { key: PROJECT.key, environment: 'staging' });
  });

  it('exits 3 when the commit id already held still matches', async () => {
    const run = await pull(['--target', 'env:staging', '--current', STAGING.deployment]);
    assert.equal(run.code, 3, run.stderr);
    assert.deepEqual(readdirSync(run.out), []);
  });

  it('exits 4 when nothing is live on the environment', async () => {
    const run = await pull(['--target', 'env:production']);
    assert.equal(run.code, 4);
    assert.match(run.stderr, /Nothing to pull for "env:production"/);
  });

  it('exits 1 for a project the token cannot reach', async () => {
    const run = await pull([], { DONKA_PROJECT: 'other-project' });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /cannot reach project "other-project"/);
  });

  it('exits 1 with Studio’s reason for a target it cannot resolve', async () => {
    for (const [target, code] of [
      ['branch:main', 'UNSUPPORTED_TARGET'],
      ['release:9.9.9', 'RELEASE_NOT_FOUND'],
      ['tag:x', 'INVALID_TARGET'],
    ] as const) {
      const run = await pull(['--target', target]);
      assert.equal(run.code, 1);
      assert.match(run.stderr, new RegExp(code));
    }
  });

  it('exits 1 when the token is refused', async () => {
    const run = await pull([], { DONKA_TOKEN: 'dnk_ci_revoked' });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /CI token was rejected \(401\)/);
  });

  it('exits 1 when the download does not match its checksum', async () => {
    studio.tamper = true;
    try {
      const run = await pull([]);
      assert.equal(run.code, 1);
      assert.match(run.stderr, /checksum mismatch/);
      assert.deepEqual(readdirSync(run.out), []);
    } finally {
      studio.tamper = false;
    }
  });

  it('exits 2 when the project or the token is missing', async () => {
    assert.equal((await pull([], { DONKA_PROJECT: '' })).code, 2);
    assert.match((await pull([], { DONKA_TOKEN: '' })).stderr, /set DONKA_TOKEN/);
  });

  it('accepts the Studio address, /api and /api/v1', async () => {
    for (const url of [`${studio.url}/`, `${studio.url}/api`, `${studio.url}/api/v1/`]) {
      assert.equal((await pull([], { DONKA_URL: url })).code, 0, url);
    }
    assert.ok(studio.calls.every((call) => call.includes(' /api/v1/rules-sync')));
  });
});
