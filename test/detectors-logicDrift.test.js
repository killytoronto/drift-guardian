'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detectLogicDrift } = require('../src/detectors/logicDrift');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guardian-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeConfig() {
  return {
    docsDrift: { enabled: false },
    logicDrift: {
      enabled: true,
      rules: [
        {
          name: 'Billing',
          codeFiles: ['src/billing/**/*.js'],
          policyFiles: ['docs/*.md']
        }
      ]
    },
    output: {
      format: 'github-comment',
      severity: { docsDrift: 'warning', logicDrift: 'error' },
      failOnError: true
    }
  };
}

test('detectLogicDrift reports missing policy files', async () => withTempDir(async (dir) => {
  const results = await detectLogicDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/billing/refund.js' }],
    config: makeConfig()
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'policy-missing');
  assert.equal(results[0].deterministic, true);
}));

test('detectLogicDrift flags policy-not-updated when code changes', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'refund.md'), 'Refunds are allowed for 30 days.');

  const results = await detectLogicDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/billing/refund.js' }],
    config: makeConfig()
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'policy-not-updated');
  assert.equal(results[0].severity, 'error');
}));

test('detectLogicDrift compares numeric values against policy docs', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'refund.md'), 'Refunds are allowed for 30 days.');

  const config = makeConfig();
  config.logicDrift.rules[0].comparisons = [
    {
      name: 'Refund window (days)',
      code_pattern: 'refundWindowDays\\s*=\\s*(\\d+)',
      policy_pattern: '(\\d+)\\s*days?',
      compare: 'equals'
    }
  ];

  const results = await detectLogicDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/billing/refund.js' }],
    config,
    baseSha: 'base',
    headSha: 'head',
    getFileDiff: () => 'diff --git a/refund.js b/refund.js\n+const refundWindowDays = 7;'
  });

  assert.ok(results.some((r) => r.type === 'policy-value-mismatch'));
}));

test('detectLogicDrift resets regex state after safety check', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'policy.md'), 'bbbb');

  const config = makeConfig();
  config.logicDrift.rules[0].comparisons = [
    {
      name: 'Regex safety',
      code_pattern: 'a+',
      policy_pattern: 'b+',
      compare: 'equals'
    }
  ];

  const results = await detectLogicDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/billing/refund.js' }],
    config,
    baseSha: 'base',
    headSha: 'head',
    getFileDiff: () => 'aaaa'
  });

  assert.ok(results.some((r) => r.type === 'policy-value-mismatch'));
}));

test('detectLogicDrift reports policy value missing', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'refund.md'), 'Refund policy TBD.');

  const config = makeConfig();
  config.logicDrift.rules[0].comparisons = [
    {
      name: 'Refund window (days)',
      code_pattern: 'refundWindowDays\\s*=\\s*(\\d+)',
      policy_pattern: '(\\d+)\\s*days?',
      compare: 'equals'
    }
  ];

  const results = await detectLogicDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/billing/refund.js' }],
    config,
    baseSha: 'base',
    headSha: 'head',
    getFileDiff: () => 'diff --git a/refund.js b/refund.js\n+const refundWindowDays = 7;'
  });

  assert.ok(results.some((r) => r.type === 'policy-value-missing'));
}));

test('detectLogicDrift ignores when policy files also changed', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'refund.md'), 'Refunds are allowed for 30 days.');

  const results = await detectLogicDrift({
    repoRoot: dir,
    changedFiles: [
      { path: 'src/billing/refund.js' },
      { path: 'docs/refund.md' }
    ],
    config: makeConfig()
  });

  assert.equal(results.length, 0);
}));

test('detectLogicDrift adds LLM findings when enabled', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'refund.md'), 'Refunds are allowed for 30 days.');

  const config = makeConfig();
  config.llm = { enabled: true, provider: 'mock', model: 'mock', mockResponse: '{"contradicts_policy":true,"severity":"critical","explanation":"Refund window changed","suggestion":"Align"}' };

  const results = await detectLogicDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/billing/refund.js' }],
    config,
    llm: { complete: async () => config.llm.mockResponse },
    baseSha: 'base',
    headSha: 'head',
    getFileDiff: () => 'diff --git a/refund.js b/refund.js\n-30\n+7'
  });

  assert.ok(results.some((r) => r.source === 'logic-drift-llm' && r.deterministic === false));
}));
