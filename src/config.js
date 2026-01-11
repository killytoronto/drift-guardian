'use strict';

const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./utils/yaml');
const { parseBoolean } = require('./utils/text');

// Default configuration limits
const DEFAULT_MAX_DOC_CHARS = 20_000;
const DEFAULT_MAX_ENTITIES = 200;
const DEFAULT_FULL_SCAN_MAX_FILES = 200;
const DEFAULT_LLM_TEMPERATURE = 0.1;
const DEFAULT_LLM_MAX_TOKENS = 500;

/**
 * Loads and validates configuration from a YAML or JSON file.
 * @param {string} configPath - Path to config file relative to repoRoot
 * @param {Object} opts - Options
 * @param {string} [opts.repoRoot] - Repository root path (defaults to cwd)
 * @param {string} [opts.llmApiKey] - Override LLM API key
 * @param {string} [opts.failOnErrorInput] - Override fail_on_error setting
 * @returns {Object} Normalized configuration object
 * @throws {Error} If config file not found or invalid
 */
function loadConfig(configPath, opts) {
  const repoRoot = opts.repoRoot || process.cwd();
  const resolved = path.resolve(repoRoot, configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  let config;
  if (configPath.endsWith('.json')) {
    config = JSON.parse(raw);
  } else {
    config = parseYaml(raw);
  }

  const normalized = normalizeConfig(config);

  if (opts.llmApiKey) {
    normalized.llm.apiKey = opts.llmApiKey;
  }
  if (normalized.llm.apiKey) {
    normalized.llm.apiKey = resolveEnv(normalized.llm.apiKey);
  }
  if (opts.failOnErrorInput !== undefined && opts.failOnErrorInput !== '') {
    normalized.output.failOnError = parseBoolean(opts.failOnErrorInput, normalized.output.failOnError);
  }

  if (normalized.llm.enabled && !normalized.llm.model) {
    throw new Error('llm.model is required when llm.enabled is true');
  }

  return normalized;
}

function normalizeConfig(config) {
  const docs = config['docs-drift'] || config.docsDrift || {};
  const logic = config['logic-drift'] || config.logicDrift || {};
  const output = config.output || {};
  const llm = config.llm || {};

  const docsDrift = {
    enabled: docs.enabled !== false,
    codeFiles: ensureArray(docs['code-files'] || docs.codeFiles),
    docFiles: ensureArray(docs['doc-files'] || docs.docFiles),
    fullScan: parseFullScan(docs.full_scan ?? docs.fullScan, 'auto'),
    fullScanMaxFiles: numberOrDefault(docs.full_scan_max_files ?? docs.fullScanMaxFiles, DEFAULT_FULL_SCAN_MAX_FILES),
    extract: ensureArray(docs.extract || [
      'function-signatures',
      'class-names',
      'api-endpoints',
      'env-variables',
      'config-keys',
      'cli-flags',
      'payload-keys'
    ]),
    maxDocChars: numberOrDefault(docs.max_doc_chars || docs.maxDocChars, DEFAULT_MAX_DOC_CHARS),
    maxEntities: numberOrDefault(docs.max_entities || docs.maxEntities, DEFAULT_MAX_ENTITIES),
    payloadKeysAllowlist: ensureArray(docs.payload_keys_allowlist ?? docs.payloadKeysAllowlist)
  };

  const docsRules = Array.isArray(docs.rules) ? docs.rules.map((rule) => normalizeDocsRule(rule, docsDrift)) : [];
  docsDrift.rules = docsRules;

  const logicDrift = {
    enabled: logic.enabled !== false,
    rules: Array.isArray(logic.rules) ? logic.rules : []
  };

  const severity = output.severity || {};

  const outputConfig = {
    format: output.format || 'github-comment',
    severity: {
      docsDrift: severity['docs-drift'] || severity.docsDrift || 'warning',
      logicDrift: severity['logic-drift'] || severity.logicDrift || 'error'
    },
    failOnError: output.fail_on_error !== undefined
      ? output.fail_on_error
      : (output.failOnError !== undefined ? output.failOnError : true),
    allowNonDeterministicFail: output.allow_nondeterministic_fail !== undefined
      ? output.allow_nondeterministic_fail
      : (output.allowNonDeterministicFail !== undefined ? output.allowNonDeterministicFail : false)
  };

  const llmConfig = {
    enabled: parseBoolean(llm.enabled, false),
    provider: (llm.provider || llm.type || 'openai-compatible').toLowerCase(),
    model: llm.model,
    apiKey: llm.api_key || llm.apiKey,
    baseUrl: llm.base_url || llm.baseUrl,
    temperature: numberOrDefault(llm.temperature, DEFAULT_LLM_TEMPERATURE),
    maxTokens: numberOrDefault(llm.max_tokens || llm.maxTokens, DEFAULT_LLM_MAX_TOKENS),
    mockResponse: llm.mock_response || llm.mockResponse
  };

  return {
    version: config.version || 1,
    llm: llmConfig,
    docsDrift,
    logicDrift,
    output: outputConfig
  };
}

/**
 * Resolves environment variable references in config values.
 * Supports two formats:
 *   - GitHub Actions style: ${{ env.VAR_NAME }}
 *   - Simple shell style: ${VAR_NAME}
 * @param {string} value - Config value to resolve
 * @returns {string} Resolved value or original if not an env reference
 */
function resolveEnv(value) {
  if (typeof value !== 'string') {
    return value;
  }

  // Match GitHub Actions style: ${{ env.VAR_NAME }}
  const envMatch = value.match(/^\$\{\{\s*env\.([A-Z0-9_]+)\s*\}\}$/);
  if (envMatch) {
    return process.env[envMatch[1]] || '';
  }

  // Match simple shell style: ${VAR_NAME}
  const simpleMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (simpleMatch) {
    return process.env[simpleMatch[1]] || '';
  }

  return value;
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

function numberOrDefault(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const num = Number(value);
  return Number.isNaN(num) ? fallback : num;
}

function parseFullScan(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'string' && value.trim().toLowerCase() === 'auto') {
    return 'auto';
  }
  return parseBoolean(value, fallback);
}

function normalizeDocsRule(rule, defaults) {
  const normalized = {
    name: rule.name || rule.label || '',
    codeFiles: ensureArray(rule['code-files'] ?? rule.codeFiles ?? defaults.codeFiles),
    docFiles: ensureArray(rule['doc-files'] ?? rule.docFiles ?? defaults.docFiles),
    fullScan: parseFullScan(rule.full_scan ?? rule.fullScan, defaults.fullScan),
    fullScanMaxFiles: numberOrDefault(rule.full_scan_max_files ?? rule.fullScanMaxFiles, defaults.fullScanMaxFiles),
    extract: ensureArray(rule.extract ?? defaults.extract),
    maxDocChars: numberOrDefault(rule.max_doc_chars ?? rule.maxDocChars, defaults.maxDocChars),
    maxEntities: numberOrDefault(rule.max_entities ?? rule.maxEntities, defaults.maxEntities),
    payloadKeysAllowlist: ensureArray(rule.payload_keys_allowlist ?? rule.payloadKeysAllowlist ?? defaults.payloadKeysAllowlist)
  };
  return normalized;
}

module.exports = {
  loadConfig
};
