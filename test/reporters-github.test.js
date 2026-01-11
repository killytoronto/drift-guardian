'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatResultsMarkdown } = require('../src/reporters/github');

test('formatResultsMarkdown groups severities', () => {
  const results = [
    { source: 'docs-drift', type: 'docs-drift', severity: 'warning', explanation: 'Doc mismatch.' },
    { source: 'logic-drift', type: 'policy-contradiction', severity: 'error', explanation: 'Policy mismatch.' }
  ];

  const markdown = formatResultsMarkdown(results, {
    output: { severity: { docsDrift: 'warning', logicDrift: 'error' } }
  });

  assert.match(markdown, /### Errors/);
  assert.match(markdown, /### Warnings/);
  assert.match(markdown, /docs-drift/);
  assert.match(markdown, /logic-drift/);
});
