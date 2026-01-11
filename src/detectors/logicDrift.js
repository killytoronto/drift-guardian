'use strict';

const fs = require('fs');
const path = require('path');
const { matchAny } = require('../utils/glob');
const { findFiles } = require('../utils/io');
const { getFileDiff: defaultGetFileDiff } = require('../git');
const { buildLogicDriftPrompt } = require('../llm/prompts');
const { safeParseJson, truncateText, isTruthy } = require('../utils/text');
const { normalizeSeverity } = require('../utils/severity');

// Default limits for text processing
const DEFAULT_MAX_DIFF_CHARS = 12_000;
const DEFAULT_MAX_POLICY_CHARS = 20_000;

// Maximum execution time for regex patterns (ReDoS protection)
const MAX_REGEX_TIME_MS = 100;

/**
 * Detects drift between code changes and business policy documents.
 * Compares values extracted from code diffs against policy documents
 * using deterministic regex comparisons and optional LLM analysis.
 * @param {Object} params - Detection parameters
 * @param {string} params.repoRoot - Repository root path
 * @param {Array} params.changedFiles - List of changed files with path and status
 * @param {Object} params.config - Configuration object
 * @param {Object|null} [params.llm] - LLM client for semantic analysis (optional)
 * @param {string} params.baseSha - Base commit SHA for diff
 * @param {string} params.headSha - Head commit SHA for diff
 * @param {Function} [params.getFileDiff] - Function to get file diff (optional)
 * @returns {Promise<Array>} Array of policy drift detection results
 */
async function detectLogicDrift(params) {
  const repoRoot = params.repoRoot;
  const changedFiles = params.changedFiles;
  const config = params.config;
  const llm = params.llm;
  const baseSha = params.baseSha;
  const headSha = params.headSha;
  const getFileDiff = params.getFileDiff || defaultGetFileDiff;

  const rules = config.logicDrift.rules || [];
  const results = [];

  const useLLM = config.llm && config.llm.enabled && llm;

  for (const rule of rules) {
    const ruleName = rule.name || 'Policy Rule';
    const codePatterns = ensureArray(rule.codeFiles || rule['code-files']);
    const policyPatterns = ensureArray(rule.policyFiles || rule['policy-files']);
    const comparisons = ensureArray(rule.comparisons || rule['comparisons'] || rule['deterministic-rules'] || rule.deterministicRules);

    const matchedFiles = changedFiles
      .map((f) => f.path)
      .filter((file) => matchAny(file, codePatterns));

    if (matchedFiles.length === 0) {
      continue;
    }

    const policyFiles = findFiles(repoRoot, policyPatterns);
    if (policyFiles.length === 0) {
      results.push({
        source: 'logic-drift',
        type: 'policy-missing',
        severity: 'warning',
        deterministic: true,
        rule: ruleName,
        explanation: `No policy files found for rule: ${ruleName}`,
        suggestion: 'Check policy file patterns in the config.'
      });
      continue;
    }

    const changedPolicyFiles = changedFiles
      .map((f) => f.path)
      .filter((file) => matchAny(file, policyPatterns));

    if (changedPolicyFiles.length === 0) {
      results.push({
        source: 'logic-drift',
        type: 'policy-not-updated',
        severity: normalizeSeverity(config.output.severity.logicDrift, 'error'),
        deterministic: true,
        rule: ruleName,
        file: matchedFiles[0],
        explanation: 'Sensitive code changed but policy docs were not updated in this PR.',
        suggestion: 'Update the policy docs or confirm the change does not affect policy.'
      });
    }
    const needsDiff = comparisons.length > 0 || useLLM;
    const diffText = needsDiff ? matchedFiles.map((file) => {
      const diff = getFileDiff(baseSha, headSha, file);
      return `FILE: ${file}\n${truncateText(diff, config.logicDrift.maxDiffChars || DEFAULT_MAX_DIFF_CHARS)}`;
    }).join('\n\n') : '';

    const needsPolicyText = comparisons.length > 0 || useLLM;
    const policyText = needsPolicyText ? policyFiles.map((file) => {
      const fullPath = path.resolve(repoRoot, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      return `FILE: ${file}\n${truncateText(content, config.logicDrift.maxPolicyChars || DEFAULT_MAX_POLICY_CHARS)}`;
    }).join('\n\n') : '';

    if (comparisons.length > 0) {
      results.push(...runDeterministicComparisons({
        comparisons,
        diffText,
        policyText,
        config,
        ruleName,
        file: matchedFiles[0]
      }));
    }

    if (!useLLM) {
      continue;
    }

    const prompt = buildLogicDriftPrompt({
      ruleName,
      codeDiff: diffText,
      policyText
    });

    const response = await llm.complete(prompt);
    const data = safeParseJson(response);

    if (!data) {
      results.push({
        source: 'logic-drift-llm',
        type: 'llm-parse-error',
        severity: 'warning',
        deterministic: false,
        rule: ruleName,
        explanation: 'LLM response could not be parsed as JSON.',
        suggestion: 'Check the prompt/output or reduce input size.'
      });
      continue;
    }

    if (!isTruthy(data.contradicts_policy)) {
      continue;
    }

    results.push({
      source: 'logic-drift-llm',
      type: 'policy-contradiction',
      severity: normalizeSeverity(data.severity, config.output.severity.logicDrift),
      deterministic: false,
      rule: ruleName,
      file: matchedFiles[0],
      policySection: data.affected_policy_section || '',
      explanation: data.explanation || '',
      suggestion: data.suggestion || ''
    });
  }

  return results;
}

function ensureArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

function runDeterministicComparisons(params) {
  const results = [];
  const comparisons = params.comparisons || [];
  const diffText = params.diffText || '';
  const policyText = params.policyText || '';
  const config = params.config;
  const ruleName = params.ruleName;
  const file = params.file;
  const seen = new Set();

  for (const comparison of comparisons) {
    const codePattern = comparison.code_pattern || comparison.codePattern;
    const policyPattern = comparison.policy_pattern || comparison.policyPattern;
    if (!codePattern || !policyPattern) {
      continue;
    }

    const codeRegex = buildRegex(codePattern, comparison.code_flags || comparison.codeFlags);
    const policyRegex = buildRegex(policyPattern, comparison.policy_flags || comparison.policyFlags);
    const codeValues = extractMatches(diffText, codeRegex);
    if (codeValues.length === 0) {
      continue;
    }

    const policyValues = extractMatches(policyText, policyRegex);
    const compare = (comparison.compare || 'equals').toLowerCase();
    const valueType = (comparison.value_type || comparison.valueType || 'auto').toLowerCase();
    const severity = normalizeSeverity(comparison.severity, config.output.severity.logicDrift);
    const label = comparison.name || comparison.label || ruleName;

    if (policyValues.length === 0) {
      const key = `${label}:missing:${codeValues.join(',')}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({
        source: 'logic-drift',
        type: 'policy-value-missing',
        severity,
        deterministic: true,
        rule: ruleName,
        file,
        explanation: `Policy value missing for ${label}. Code changed to ${codeValues.join(', ')} but no matching policy value was found.`,
        suggestion: 'Update policy docs to include the value or adjust the code.'
      });
      continue;
    }

    for (const codeValue of codeValues) {
      const satisfied = policyValues.some((policyValue) => compareValues(codeValue, policyValue, compare, valueType));
      if (satisfied) {
        continue;
      }
      const key = `${label}:mismatch:${codeValue}:${policyValues.join(',')}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({
        source: 'logic-drift',
        type: 'policy-value-mismatch',
        severity,
        deterministic: true,
        rule: ruleName,
        file,
        explanation: `Policy mismatch for ${label}. Code uses ${codeValue}, policy says ${policyValues.join(', ')}.`,
        suggestion: 'Align code and policy to the same value.'
      });
    }
  }

  return results;
}

function buildRegex(pattern, flags) {
  if (pattern instanceof RegExp) {
    return validateRegexSafety(pattern);
  }
  if (typeof pattern !== 'string') {
    return null;
  }

  let regex;
  try {
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const lastSlash = pattern.lastIndexOf('/');
      const body = pattern.slice(1, lastSlash);
      const finalFlags = pattern.slice(lastSlash + 1) || flags || 'g';
      regex = new RegExp(body, finalFlags);
    } else {
      regex = new RegExp(pattern, flags || 'g');
    }
  } catch (err) {
    throw new Error(`Invalid regex pattern "${pattern}": ${err.message}`);
  }

  return validateRegexSafety(regex);
}

/**
 * Validates that a regex pattern is safe from ReDoS attacks.
 * Tests the pattern against known pathological inputs and rejects
 * patterns that take too long to execute.
 * @param {RegExp} regex - The regex pattern to validate
 * @returns {RegExp} The validated regex
 * @throws {Error} If the pattern exhibits ReDoS vulnerability
 */
function validateRegexSafety(regex) {
  const shouldReset = regex.global || regex.sticky;
  // Test regex against known pathological cases to detect ReDoS vulnerabilities
  const testCases = [
    'a'.repeat(50),           // Simple repetition
    'aaaaaaaaaaaaaaaaaX',     // Repetition with mismatch at end
    'a'.repeat(30) + 'b'     // Alternating pattern
  ];

  for (const testCase of testCases) {
    if (shouldReset) {
      regex.lastIndex = 0;
    }
    const startTime = Date.now();
    try {
      regex.test(testCase);
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_REGEX_TIME_MS) {
        throw new Error(`Regex pattern is too complex (took ${elapsed}ms, max ${MAX_REGEX_TIME_MS}ms). Potential ReDoS vulnerability detected.`);
      }
    } catch (err) {
      if (err.message.includes('ReDoS')) {
        throw err;
      }
      // Other errors (like invalid regex) are ok to ignore here
    }
  }

  if (shouldReset) {
    regex.lastIndex = 0;
  }
  return regex;
}

function extractMatches(text, regex) {
  if (!regex) {
    return [];
  }
  const values = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = match[1] !== undefined ? match[1] : match[0];
    values.push(String(value).trim());
    if (!regex.global) {
      break;
    }
  }
  return values;
}

function compareValues(codeValue, policyValue, compare, valueType) {
  const { numeric: codeNum, text: codeText } = normalizeValue(codeValue, valueType);
  const { numeric: policyNum, text: policyText } = normalizeValue(policyValue, valueType);

  const numericCompare = Number.isFinite(codeNum) && Number.isFinite(policyNum);
  if (numericCompare) {
    switch (compare) {
    case 'eq':
    case 'equals':
      return codeNum === policyNum;
    case 'not_equals':
    case 'ne':
      return codeNum !== policyNum;
    case 'gt':
      return codeNum > policyNum;
    case 'gte':
    case 'ge':
      return codeNum >= policyNum;
    case 'lt':
      return codeNum < policyNum;
    case 'lte':
    case 'le':
      return codeNum <= policyNum;
    default:
      return codeNum === policyNum;
    }
  }

  const left = codeText.toLowerCase();
  const right = policyText.toLowerCase();
  switch (compare) {
  case 'not_equals':
  case 'ne':
    return left !== right;
  case 'contains':
    return left.includes(right) || right.includes(left);
  default:
    return left === right;
  }
}

function normalizeValue(value, valueType) {
  if (valueType === 'string') {
    return { numeric: Number.NaN, text: String(value).trim() };
  }
  if (valueType === 'number' || valueType === 'int' || valueType === 'float') {
    return { numeric: parseNumber(value), text: String(value).trim() };
  }
  const num = parseNumber(value);
  if (Number.isFinite(num)) {
    return { numeric: num, text: String(value).trim() };
  }
  return { numeric: Number.NaN, text: String(value).trim() };
}

function parseNumber(value) {
  if (value === null || value === undefined) {
    return Number.NaN;
  }
  const cleaned = String(value).replace(/[, _]/g, '');
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

module.exports = {
  detectLogicDrift
};
