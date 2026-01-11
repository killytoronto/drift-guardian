'use strict';

function normalizeSeverity(value, fallback) {
  const normalized = normalize(value);
  if (normalized) {
    return normalized;
  }
  const fallbackNormalized = normalize(fallback);
  return fallbackNormalized || 'warning';
}

function normalize(value) {
  if (!value) {
    return '';
  }
  const v = String(value).toLowerCase();
  if (v === 'critical' || v === 'error' || v === 'warning' || v === 'info') {
    return v;
  }
  return '';
}

module.exports = {
  normalizeSeverity
};
