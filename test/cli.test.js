'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI_ENTRY = path.resolve(__dirname, '..', 'src', 'cli.js');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guardian-cli-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFiles(root, files) {
  for (const file of files) {
    const fullPath = path.join(root, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
  }
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Drift Guardian'], { cwd: dir });
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', message], { cwd: dir });
}

function getSha(dir, rev) {
  return execFileSync('git', ['rev-parse', rev], { cwd: dir, encoding: 'utf8' }).trim();
}

test('cli: reports docs drift and exits non-zero', () => withTempDir((dir) => {
  initGitRepo(dir);

  writeFiles(dir, [
    { path: 'src/users.js', content: 'export function createUser(email, password) {}' },
    { path: 'README.md', content: 'createUser(email, password)' }
  ]);
  commitAll(dir, 'base');

  writeFiles(dir, [
    { path: 'src/users.js', content: 'export function createUser(username, password) {}' },
    { path: 'README.md', content: 'createUser(email, password)' }
  ]);
  commitAll(dir, 'change');

  const config = `
version: 1
docs-drift:
  enabled: true
  code-files:
    - "src/**/*.js"
  doc-files:
    - "README.md"
logic-drift:
  enabled: false
output:
  fail_on_error: true
  severity:
    docs-drift: error
`;
  fs.writeFileSync(path.join(dir, '.drift.config.yml'), config.trim() + '\n');

  const baseSha = getSha(dir, 'HEAD~1');
  const headSha = getSha(dir, 'HEAD');

  const result = spawnSync('node', [CLI_ENTRY, '--config', '.drift.config.yml', '--base', baseSha, '--head', headSha, '--format', 'json'], {
    cwd: dir,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.ok(output.results.some((r) => r.type === 'function-signature-mismatch'));
}));
