'use strict';

function truncateText(text, maxChars) {
  if (!maxChars || text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + '\n[truncated]';
}

function safeParseJson(text) {
  if (!text) {
    return null;
  }
  const cleaned = stripFence(text.trim());
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*?\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (innerErr) {
        return null;
      }
    }
  }
  return null;
}

function stripFence(text) {
  if (text.startsWith('```')) {
    return text.replace(/^```[a-zA-Z]*\n/, '').replace(/```$/, '').trim();
  }
  return text;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'y') {
    return true;
  }
  if (v === 'false' || v === '0' || v === 'no' || v === 'n') {
    return false;
  }
  return fallback;
}

function isTruthy(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}

module.exports = {
  truncateText,
  safeParseJson,
  parseBoolean,
  isTruthy
};
