import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { candidatePlan } from './candidate-release.mjs';

const source = { ref: 'develop', sha: 'a'.repeat(40) };
const workflow = readFileSync(new URL('../.github/workflows/candidate-release.yml', import.meta.url), 'utf8');

test('candidate plan accepts independent SemVer release candidates', () => {
  const plan = candidatePlan({ ...source, version: '1.5.0-rc.1' });
  assert.equal(plan.releaseTag, 'v1.5.0-rc.1');
  assert.deepEqual(plan.imageTags, ['1.5.0-rc.1']);
  assert.equal(plan.assetName, 'candidate-1.5.0-rc.1.json');
  assert.equal(plan.sourceCommit, source.sha);
});

test('candidate image plan cannot emit a stable, edge, or latest alias', () => {
  const { imageTags } = candidatePlan({ ...source, version: '0.4.0-rc.12' });
  assert.deepEqual(imageTags, ['0.4.0-rc.12']);
  assert.equal(imageTags.some((tag) => ['edge', 'latest', '0.4', '0'].includes(tag)), false);
});

test('candidate plan rejects stable, malformed, and padded versions', () => {
  for (const version of ['1.5.0', 'v1.5.0-rc.1', '1.5.0-rc.0', '01.5.0-rc.1', '1.5.0-rc.01', '1.5.0-rc.1+build']) {
    assert.throws(() => candidatePlan({ ...source, version }), /Candidate version/);
  }
});

test('candidate plan requires the reviewed develop ref and a full commit SHA', () => {
  assert.throws(() => candidatePlan({ version: '1.5.0-rc.1', ref: 'main', sha: source.sha }), /develop/);
  assert.throws(() => candidatePlan({ version: '1.5.0-rc.1', ref: 'develop', sha: 'a'.repeat(39) }), /full commit SHA/);
});

test('CLI candidates are signed prereleases and never published to npm', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cosign sign-blob/);
  assert.match(workflow, /cosign verify-blob/);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /isImmutable/);
  assert.match(workflow, /Reject a reused Git tag/);
  assert.ok(workflow.indexOf('gh release upload') < workflow.indexOf('draft=false'));
  assert.doesNotMatch(workflow, /npm publish/);
});
