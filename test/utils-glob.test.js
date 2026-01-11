'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAny } = require('../src/utils/glob');

test('matches common glob patterns', () => {
  assert.equal(matchAny('src/utils/file.js', ['src/**/*.js']), true);
  assert.equal(matchAny('src/utils/file.ts', ['src/**/*.js']), false);
  assert.equal(matchAny('README.md', ['docs/**/*.md']), false);
  assert.equal(matchAny('docs/readme.md', ['docs/**/*.md']), true);
  assert.equal(matchAny('src/utils/file.js', ['src/**/file.?s']), true);
  assert.equal(matchAny('src/utils/file.jsx', ['src/**/file.?s']), false);
  assert.equal(matchAny('config/.env', ['**/.env']), true);
});

test('normalizes windows paths', () => {
  assert.equal(matchAny('src\\utils\\file.js', ['src/**/*.js']), true);
});
