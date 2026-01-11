'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYaml } = require('../src/utils/yaml');

test('parse nested maps and lists', () => {
  const input = `
version: 1
llm:
  provider: llm7
  max_tokens: 200
docs-drift:
  enabled: true
  code-files:
    - "src/**/*.js"
    - "src/**/*.ts"
  extract:
    - function-signatures
    - env-variables
logic-drift:
  enabled: false
  rules:
    - name: Billing
      code-files:
        - "src/billing/**/*.ts"
      policy-files:
        - "docs/refund.md"
`;

  const data = parseYaml(input);
  assert.equal(data.version, 1);
  assert.equal(data.llm.provider, 'llm7');
  assert.equal(data.llm.max_tokens, 200);
  assert.equal(data['docs-drift'].enabled, true);
  assert.deepEqual(data['docs-drift']['code-files'], ['src/**/*.js', 'src/**/*.ts']);
  assert.deepEqual(data['docs-drift'].extract, ['function-signatures', 'env-variables']);
  assert.equal(data['logic-drift'].enabled, false);
  assert.equal(data['logic-drift'].rules[0].name, 'Billing');
  assert.deepEqual(data['logic-drift'].rules[0]['policy-files'], ['docs/refund.md']);
});

test('parses scalars and preserves comments inside quotes', () => {
  const input = `
name: "Foo # not comment"
note: 'Bar # still text'
flag: true
count: 10
ratio: 0.5
none: null
`;

  const data = parseYaml(input);
  assert.equal(data.name, 'Foo # not comment');
  assert.equal(data.note, 'Bar # still text');
  assert.equal(data.flag, true);
  assert.equal(data.count, 10);
  assert.equal(data.ratio, 0.5);
  assert.equal(data.none, null);
});

test('throws on list at root', () => {
  assert.throws(() => parseYaml('- item'), /list item without array/);
});
