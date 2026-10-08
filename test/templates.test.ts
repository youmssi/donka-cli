import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { PROJECT, STAGING, TOKEN, spawnAsync, startFakeStudio, type FakeStudio } from './fake-studio.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FILES = ['actions/pull/action.yml', 'templates/gitlab-ci-pull.yml', 'templates/azure-pipelines-pull.yml'];

let studio: FakeStudio;
let work: string;
/** The CLI as a release ships it, so the templates run what pipelines run. */
let cliPackage: string;

before(async () => {
  studio = await startFakeStudio();
  work = mkdtempSync(join(tmpdir(), 'donka-templates-'));
  execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: ROOT, stdio: 'ignore' });
  const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
  assert.ok(tarball, 'npm pack wrote the package');
  cliPackage = join(work, tarball);
});
after(async () => {
  await studio.close();
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  dir: string;
}

/** Runs a template's script the way its CI system would, in a fresh directory. */
const run = async (shell: string, script: string, env: Record<string, string>): Promise<Run> => {
  const dir = mkdtempSync(join(work, 'run-'));
  const result = await spawnAsync(shell, ['-c', script], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      npm_config_cache: join(work, 'npm-cache'),
      npm_config_update_notifier: 'false',
      ...env,
    },
  });
  return { ...result, dir };
};

const keyValues = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

describe('templates', () => {
  it('carry no GoRules name, payload or npm package', () => {
    for (const file of FILES) {
      const text = readFileSync(join(ROOT, file), 'utf-8');
      assert.doesNotMatch(text, /gorules|brms|GRL_PAYLOAD|payload/i, file);
      assert.match(text, /npx --yes --package "\$package" donka /, file);
      assert.match(text, /github\.com\/youmssi\/donka-cli\/releases\/download\/v\$\{?/, file);
    }
  });

  describe('GitHub action', () => {
    interface Action {
      inputs: Record<string, { default?: string }>;
      runs: { steps: { run: string; env: Record<string, string> }[] };
    }
    const action = parse(readFileSync(join(ROOT, 'actions/pull/action.yml'), 'utf-8')) as Action;
    const [step] = action.runs.steps;
    assert.ok(step);

    const pull = async (inputs: Record<string, string>) => {
      const values: Record<string, string> = {
        ...Object.fromEntries(Object.entries(action.inputs).map(([key, input]) => [key, input.default ?? ''])),
        url: studio.url,
        token: TOKEN,
        project: PROJECT.key,
        'cli-package': cliPackage,
        ...inputs,
      };
      const env = Object.fromEntries(
        Object.entries(step.env).map(([key, expression]) => {
          const name = /inputs(?:\.([\w]+)|\['([\w-]+)'\])/.exec(expression);
          return [key, values[name?.[1] ?? name?.[2] ?? ''] ?? ''];
        }),
      );
      const temp = mkdtempSync(join(work, 'runner-'));
      const outputs = join(temp, 'outputs');
      writeFileSync(outputs, '');
      const result = await run('bash', step.run, { ...env, GITHUB_OUTPUT: outputs, RUNNER_TEMP: temp });
      return { ...result, outputs: keyValues(readFileSync(outputs, 'utf-8')) };
    };

    it('pulls and sets the outputs', async () => {
      const result = await pull({ target: 'env:staging', unpack: 'true', name: '.' });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs.changed, 'true');
      assert.equal(result.outputs.project, PROJECT.key);
      assert.equal(result.outputs.version, '1.0.0');
      assert.equal(result.outputs.commit, STAGING.deployment);
      assert.match(result.outputs.sha256 ?? '', /^[0-9a-f]{64}$/);
      assert.match(result.stdout, new RegExp(`::add-mask::${TOKEN}`));
      assert.ok(readdirSync(join(result.dir, '.config')).includes('project.json'));
    });

    it('reports changed=false and succeeds when the target has not moved', async () => {
      const result = await pull({ target: 'env:staging', current: STAGING.deployment });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs.changed, 'false');
    });

    it('fails with the CLI’s exit code otherwise', async () => {
      assert.equal((await pull({ target: 'env:production' })).code, 4);
      assert.equal((await pull({ project: '' })).code, 2);
    });
  });

  describe('GitLab CI', () => {
    const job = (parse(readFileSync(join(ROOT, 'templates/gitlab-ci-pull.yml'), 'utf-8')) as Record<string, unknown>)[
      '.donka-pull'
    ] as { variables: Record<string, string>; script: string[]; artifacts: { reports: { dotenv: string } } };

    const pull = async (variables: Record<string, string>) => {
      const result = await run('sh', job.script.join('\n'), {
        ...job.variables,
        DONKA_URL: studio.url,
        DONKA_TOKEN: TOKEN,
        DONKA_PROJECT: PROJECT.key,
        DONKA_CLI_PACKAGE: cliPackage,
        ...variables,
      });
      const report = join(result.dir, job.artifacts.reports.dotenv);
      return { ...result, report: result.code === 0 ? keyValues(readFileSync(report, 'utf-8')) : {} };
    };

    it('pulls into DONKA_OUT and writes the dotenv report', async () => {
      const result = await pull({ DONKA_TARGET: 'release:1.0.0' });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(readdirSync(join(result.dir, 'dist')), [PROJECT.key]);
      assert.equal(result.report.RULES_CHANGED, 'true');
      assert.equal(result.report.RULES_VERSION, '1.0.0');
      assert.equal(result.report.RULES_COMMIT, 'r-1');
      assert.equal(result.report.RULES_TARGET, 'release:1.0.0');
    });

    it('reports RULES_CHANGED=false when the target has not moved', async () => {
      const result = await pull({ DONKA_CURRENT: 'r-2' });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.report.RULES_CHANGED, 'false');
    });

    it('fails with the CLI’s exit code otherwise', async () => {
      assert.equal((await pull({ DONKA_TARGET: 'env:production' })).code, 4);
      assert.equal((await pull({ DONKA_PROJECT: '' })).code, 2);
    });
  });

  describe('Azure Pipelines', () => {
    interface Template {
      parameters: { name: string; default?: unknown }[];
      steps: { script?: string; env?: Record<string, string> }[];
    }
    const template = parse(readFileSync(join(ROOT, 'templates/azure-pipelines-pull.yml'), 'utf-8')) as Template;
    const step = template.steps.find((item) => item.script);
    assert.ok(step?.script && step.env);

    /** Azure expands template expressions and macros before the script runs. */
    const pull = async (parameters: Record<string, string | boolean>) => {
      const values: Record<string, unknown> = {
        ...Object.fromEntries(template.parameters.map((item) => [item.name, item.default ?? ''])),
        url: studio.url,
        project: PROJECT.key,
        cliPackage,
        out: 'rules',
        ...parameters,
      };
      const expand = (text: string) =>
        text
          .replace(/\$\{\{ lower\(parameters\.(\w+)\) \}\}/g, (_, name: string) => String(values[name]).toLowerCase())
          .replace(/\$\{\{ parameters\.(\w+) \}\}/g, (_, name: string) => String(values[name]))
          .replace('$(DONKA_TOKEN)', TOKEN);
      const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, expand(value)]));
      const result = await run('bash', expand(step.script ?? ''), env);
      const variables: Record<string, string> = {};
      for (const [, key = '', value = ''] of result.stdout.matchAll(/##vso\[task\.setvariable variable=(\w+)\](.*)/g)) {
        variables[key] = value;
      }
      return { ...result, variables };
    };

    it('pulls and sets the result variables', async () => {
      const result = await pull({ target: 'main' });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(readdirSync(join(result.dir, 'rules')), [PROJECT.key]);
      assert.equal(result.variables.rulesChanged, 'true');
      assert.equal(result.variables.rulesVersion, '1.1.0');
      assert.equal(result.variables.rulesRelease, 'r-2');
      assert.equal(result.variables.rulesProject, PROJECT.key);
    });

    it('sets rulesChanged=false when the target has not moved', async () => {
      const result = await pull({ target: 'commit:r-1', current: 'r-1' });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.variables.rulesChanged, 'false');
    });

    it('fails with the CLI’s exit code otherwise', async () => {
      assert.equal((await pull({ target: 'env:production' })).code, 4);
    });
  });
});
