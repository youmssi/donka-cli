import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  LIMITS_CONTRACT,
  PROJECT,
  STAGING,
  TOKEN,
  contract,
  spawnAsync,
  startFakeStudio,
  type FakeStudio,
} from './fake-studio.ts';

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
}

const donka = async (args: string[], env: Record<string, string> = {}): Promise<Run> => {
  const result = await spawnAsync(process.execPath, [CLI, ...args], {
    env: {
      PATH: process.env.PATH,
      DONKA_URL: studio.url,
      DONKA_TOKEN: TOKEN,
      DONKA_PROJECT: PROJECT.key,
      ...env,
    },
  });
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN), 'the token is never printed');
  return result;
};

const temp = () => mkdtempSync(join(tmpdir(), 'donka-form-'));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

/** Writes a JSON file in a fresh directory and returns its path. */
const file = (value: unknown, name = 'file.json'): string => {
  const path = join(temp(), name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

/** A form written for release 1.0.0, from the contract as a form team would. */
const formFor = (release: string): Record<string, unknown> =>
  JSON.parse(JSON.stringify(contract(release))) as Record<string, unknown>;

describe('donka form pull', () => {
  it('writes every decision’s contract from the target’s verified artifact', async () => {
    const out = temp();
    const run = await donka(['form', 'pull', '--target', 'release:1.0.0', '--out', out, '--json']);
    assert.equal(run.code, 0, run.stderr);
    const summary = JSON.parse(run.stdout) as Record<string, unknown>;
    assert.equal(summary.version, '1.0.0');
    assert.equal(summary.verified, true);
    assert.deepEqual(summary.decisions, ['loan', 'retail/limits']);
    assert.deepEqual(readJson(join(out, 'loan/input.schema.json')), contract('r-1'));
    assert.deepEqual(readJson(join(out, 'retail/limits/input.schema.json')), LIMITS_CONTRACT);
  });

  it('resolves every target like donka pull', async () => {
    for (const [target, version] of [
      ['main', '1.1.0'],
      ['commit:r-1', '1.0.0'],
      ['release:v1.1.0', '1.1.0'],
      ['env:staging', '1.0.0'],
    ] as const) {
      const run = await donka(['form', 'pull', '--out', temp(), '--json'], { DONKA_TARGET: target });
      assert.equal(run.code, 0, `${target}: ${run.stderr}`);
      assert.equal((JSON.parse(run.stdout) as { version: string }).version, version, target);
    }
  });

  it('pulls one decision with --decision, and fails for a decision with no contract', async () => {
    const out = temp();
    const run = await donka(['form', 'pull', '--decision', 'loan', '--out', out, '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual((JSON.parse(run.stdout) as { decisions: string[] }).decisions, ['loan']);
    assert.deepEqual(readJson(join(out, 'loan/input.schema.json')), contract('r-2'));

    const missing = await donka(['form', 'pull', '--decision', 'pricing', '--out', temp()]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Decision "pricing" has no input contract/);
  });

  it('keeps pull’s exit codes: 3 unchanged, 4 no release, 1 checksum mismatch, 2 usage', async () => {
    assert.equal((await donka(['form', 'pull', '-t', 'env:staging', '--current', STAGING.deployment])).code, 3);
    assert.equal((await donka(['form', 'pull', '-t', 'env:production'])).code, 4);
    assert.equal((await donka(['form', 'pull'], { DONKA_PROJECT: '' })).code, 2);
    studio.tamper = true;
    try {
      const run = await donka(['form', 'pull', '--out', temp()]);
      assert.equal(run.code, 1);
      assert.match(run.stderr, /checksum mismatch/);
    } finally {
      studio.tamper = false;
    }
  });
});

describe('donka form check', () => {
  const check = (contractPath: string, form: unknown) =>
    donka(['form', 'check', '--contract', contractPath, '--form', file(form, 'form.json'), '--json']);
  const differences = (run: Run) =>
    (JSON.parse(run.stdout) as { differences: { field: string; kind: string; form?: string }[] }).differences;

  it('passes when the form matches, and accepts a form wrapped with its library’s own keys', async () => {
    const path = file(contract('r-2'));
    for (const form of [formFor('r-2'), { schema: formFor('r-2'), uiSchema: { loan: { 'ui:order': ['*'] } } }]) {
      const run = await check(path, form);
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { ok: true, differences: [] });
    }
  });

  it('fails when the contract moves on: a form for 1.0.0 against 1.1.0', async () => {
    const run = await check(file(contract('r-2')), formFor('r-1'));
    assert.equal(run.code, 1);
    assert.deepEqual(differences(run), [
      { field: 'loan.termMonths', kind: 'missing', message: 'in the contract, not in the form' },
    ]);
  });

  it('reports each difference with its field path', async () => {
    const form = formFor('r-2') as {
      properties: Record<string, { properties: Record<string, unknown>; required: string[] }>;
    };
    const { applicant, loan } = form.properties;
    assert.ok(applicant && loan);
    applicant.properties.idNumber = applicant.properties.nationalId;
    delete applicant.properties.nationalId;
    applicant.properties.age = { type: 'string' };
    loan.required = ['amount'];
    loan.properties.purpose = { type: 'string' };

    const run = await check(file(contract('r-2')), form);
    assert.equal(run.code, 1);
    assert.deepEqual(
      differences(run).map(({ field, kind, form: renamed }) => [field, kind, renamed]),
      [
        ['applicant.age', 'type', undefined],
        ['applicant.nationalId', 'renamed', 'applicant.idNumber'],
        ['loan.termMonths', 'required', undefined],
        ['loan.purpose', 'unknown', undefined],
      ],
    );
  });

  it('lets a form ask for an integer where the contract takes any number, not the reverse', async () => {
    const stricter = formFor('r-2') as { properties: { loan: { properties: { amount: { type: string } } } } };
    stricter.properties.loan.properties.amount.type = 'integer';
    assert.equal((await check(file(contract('r-2')), stricter)).code, 0);

    const looser = formFor('r-2') as { properties: { applicant: { properties: { age: { type: string } } } } };
    looser.properties.applicant.properties.age.type = 'number';
    const run = await check(file(contract('r-2')), looser);
    assert.equal(run.code, 1);
    assert.match(differences(run)[0]?.field ?? '', /applicant\.age/);
  });

  it('lists the differences for people, and exits 2 or 1 for bad input', async () => {
    const form = file(formFor('r-1'), 'form.json');
    const run = await donka(['form', 'check', '-c', file(contract('r-2')), '-f', form]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /1 difference\(s\)/);
    assert.match(run.stderr, /loan\.termMonths\s+in the contract, not in the form/);

    assert.equal((await donka(['form', 'check', '-f', form])).code, 2);
    const notJson = join(temp(), 'form.json');
    writeFileSync(notJson, 'not json');
    const invalid = await donka(['form', 'check', '-c', notJson, '-f', form]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /is not valid JSON/);
    assert.match((await donka(['form', 'check', '-c', file([1, 2]), '-f', form])).stderr, /not a JSON Schema/);
  });
});

describe('donka form init', () => {
  it('writes a starting form that matches its contract, labels in the chosen language', async () => {
    const contractPath = file(contract('r-2'));
    const out = join(temp(), 'forms/loan.json');
    const run = await donka(['form', 'init', '--contract', contractPath, '--lang', 'fr', '--out', out]);
    assert.equal(run.code, 0, run.stderr);

    const form = readJson(out) as {
      properties: {
        applicant: { properties: Record<string, { title?: string }> };
        loan: { properties: { amount: { title?: string; description?: string } } };
      };
    };
    // Fields keep their contract order unless `order` says otherwise.
    assert.deepEqual(Object.keys(form.properties.applicant.properties), ['nationalId', 'age']);
    assert.equal(form.properties.applicant.properties.age?.title, 'Âge');
    assert.equal(form.properties.loan.properties.amount.title, 'Montant');
    assert.equal(form.properties.loan.properties.amount.description, 'En XAF.');

    assert.equal((await donka(['form', 'check', '-c', contractPath, '-f', out])).code, 0);
  });

  it('prints to stdout by default, in English', async () => {
    const run = await donka(['form', 'init', '-c', file(contract('r-2'))]);
    assert.equal(run.code, 0, run.stderr);
    const form = JSON.parse(run.stdout) as { properties: { applicant: { properties: { age: { title: string } } } } };
    assert.equal(form.properties.applicant.properties.age.title, 'Age');
    assert.equal((await donka(['form', 'init', '-c', file(contract('r-2')), '--lang', 'de'])).code, 2);
  });
});
