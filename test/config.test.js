'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig } = require('../src/config');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guardian-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig resolves env and defaults', () => withTempDir((dir) => {
  const prevEnv = process.env.TEST_LLM_KEY;
  process.env.TEST_LLM_KEY = 'secret';
  const configPath = path.join(dir, 'config.yml');
  const yaml = `
version: 1
llm:
  enabled: true
  provider: llm7
  model: test-model
  api_key: \${TEST_LLM_KEY}
output:
  fail_on_error: true
`;
  fs.writeFileSync(configPath, yaml);

  const config = loadConfig(configPath, { repoRoot: dir });
  assert.equal(config.llm.apiKey, 'secret');
  assert.equal(config.output.failOnError, true);
  assert.equal(config.docsDrift.enabled, true);
  assert.equal(config.docsDrift.fullScan, 'auto');
  if (prevEnv === undefined) {
    delete process.env.TEST_LLM_KEY;
  } else {
    process.env.TEST_LLM_KEY = prevEnv;
  }
}));

test('loadConfig overrides api key and fail_on_error input', () => withTempDir((dir) => {
  const configPath = path.join(dir, 'config.yml');
  const yaml = `
version: 1
llm:
  enabled: true
  provider: llm7
  model: test-model
  api_key: \${TEST_LLM_KEY}
output:
  fail_on_error: true
`;
  fs.writeFileSync(configPath, yaml);

  const config = loadConfig(configPath, {
    repoRoot: dir,
    llmApiKey: 'override-key',
    failOnErrorInput: 'false'
  });

  assert.equal(config.llm.apiKey, 'override-key');
  assert.equal(config.output.failOnError, false);
}));

test('loadConfig throws when model is missing', () => withTempDir((dir) => {
  const configPath = path.join(dir, 'config.yml');
  const yaml = `
version: 1
llm:
  enabled: true
  provider: llm7
`;
  fs.writeFileSync(configPath, yaml);

  assert.throws(() => loadConfig(configPath, { repoRoot: dir }), /llm\.model is required/);
}));

test('loadConfig allows missing model when llm is disabled', () => withTempDir((dir) => {
  const configPath = path.join(dir, 'config.yml');
  const yaml = `
version: 1
llm:
  enabled: false
output:
  fail_on_error: false
`;
  fs.writeFileSync(configPath, yaml);

  const config = loadConfig(configPath, { repoRoot: dir });
  assert.equal(config.llm.enabled, false);
  assert.equal(config.output.allowNonDeterministicFail, false);
}));

test('loadConfig normalizes docs drift rules and payload allowlist', () => withTempDir((dir) => {
  const configPath = path.join(dir, 'config.yml');
  const yaml = `
version: 1
docs-drift:
  full_scan: auto
  full_scan_max_files: 50
  payload_keys_allowlist:
    - user_id
  rules:
    - name: Public API
      code-files:
        - "src/**/*.js"
      doc-files:
        - "README.md"
      full_scan: false
      extract:
        - function-signatures
      payload_keys_allowlist:
        - "/^user_/"
`;
  fs.writeFileSync(configPath, yaml);

  const config = loadConfig(configPath, { repoRoot: dir });
  assert.equal(config.docsDrift.fullScan, 'auto');
  assert.equal(config.docsDrift.fullScanMaxFiles, 50);
  assert.deepEqual(config.docsDrift.payloadKeysAllowlist, ['user_id']);
  assert.equal(config.docsDrift.rules.length, 1);
  assert.equal(config.docsDrift.rules[0].fullScan, false);
  assert.deepEqual(config.docsDrift.rules[0].extract, ['function-signatures']);
  assert.deepEqual(config.docsDrift.rules[0].payloadKeysAllowlist, ['/^user_/']);
}));
