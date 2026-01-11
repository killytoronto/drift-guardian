'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { truncateText, safeParseJson, parseBoolean, isTruthy } = require('../src/utils/text');

test('truncateText returns original under limit', () => {
  assert.equal(truncateText('hello', 10), 'hello');
});

test('truncateText appends truncation marker', () => {
  assert.equal(truncateText('hello', 3), 'hel\n[truncated]');
});

test('safeParseJson handles valid JSON', () => {
  assert.deepEqual(safeParseJson('{"a":1}'), { a: 1 });
});

test('safeParseJson handles fenced JSON', () => {
  const text = '```json\n{"a":1}\n```';
  assert.deepEqual(safeParseJson(text), { a: 1 });
});

test('safeParseJson extracts JSON from extra text', () => {
  const text = 'Result:\n{"a":1, "b":2}';
  assert.deepEqual(safeParseJson(text), { a: 1, b: 2 });
});

test('parseBoolean respects common values', () => {
  assert.equal(parseBoolean('yes', false), true);
  assert.equal(parseBoolean('no', true), false);
  assert.equal(parseBoolean('', true), true);
});

test('isTruthy handles strings and numbers', () => {
  assert.equal(isTruthy('true'), true);
  assert.equal(isTruthy('1'), true);
  assert.equal(isTruthy('no'), false);
  assert.equal(isTruthy(0), false);
});
