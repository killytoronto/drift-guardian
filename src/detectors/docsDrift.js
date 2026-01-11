'use strict';

const fs = require('fs');
const path = require('path');
const { matchAny } = require('../utils/glob');
const { findFiles } = require('../utils/io');
const { getFileDiff: defaultGetFileDiff } = require('../git');
const { buildDocsDriftPrompt } = require('../llm/prompts');
const { safeParseJson, truncateText } = require('../utils/text');
const { normalizeSeverity } = require('../utils/severity');

// Default limits
const DEFAULT_MAX_ENTITIES = 200;
const DEFAULT_MAX_DOC_CHARS = 20_000;
const MAX_CONTENT_LENGTH = 5_000_000; // 5MB max file size for extraction
const MAX_REGEX_EXEC_TIME_MS = 1000; // Max time for all regex operations per file

// Keywords to exclude from payload key extraction
const EXCLUDED_PAYLOAD_KEYS = new Set([
  'case', 'default', 'return', 'break', 'continue', 'if', 'else', 'for', 'while', 'switch'
]);

/**
 * Validates that content is suitable for extraction.
 * @param {string} content - File content
 * @param {string} file - File path
 * @returns {{valid: boolean, reason?: string}}
 */
function validateContent(content, file) {
  if (!content || typeof content !== 'string') {
    return { valid: false, reason: 'Content is not a valid string' };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return { valid: false, reason: `File too large (${content.length} bytes, max ${MAX_CONTENT_LENGTH})` };
  }
  // Check for binary content (null bytes)
  if (content.includes('\0')) {
    return { valid: false, reason: 'File appears to be binary' };
  }
  return { valid: true };
}

/**
 * Safely executes a regex pattern with timeout protection.
 * @param {RegExp} pattern - Regex pattern
 * @param {string} content - Content to search
 * @param {number} [maxMatches=1000] - Maximum matches to return
 * @returns {Array<RegExpExecArray>}
 */
function safeRegexExec(pattern, content, maxMatches = 1000) {
  const results = [];
  const startTime = Date.now();
  let match;

  try {
    while ((match = pattern.exec(content)) !== null) {
      results.push(match);
      if (results.length >= maxMatches) {
        break;
      }
      if (Date.now() - startTime > MAX_REGEX_EXEC_TIME_MS) {
        console.warn(`Regex execution timeout for pattern ${pattern.source.slice(0, 50)}...`);
        break;
      }
      // Prevent infinite loops for non-global regexes
      if (!pattern.global) {
        break;
      }
    }
  } catch (err) {
    console.warn(`Regex execution error: ${err.message}`);
  }

  return results;
}

/**
 * Wraps an extraction function with error handling.
 * @param {Function} extractFn - Extraction function
 * @param {string} content - File content
 * @param {string} file - File path
 * @param {Array} results - Results array to populate
 * @param {string} extractorName - Name of extractor for logging
 */
function safeExtract(extractFn, content, file, results, extractorName) {
  try {
    extractFn(content, file, results);
  } catch (err) {
    console.warn(`${extractorName} extraction failed for ${file}: ${err.message}`);
  }
}

/**
 * Detects drift between code entities and documentation.
 * Extracts functions, endpoints, env vars, etc. from code files
 * and compares them against documentation files.
 * @param {Object} params - Detection parameters
 * @param {string} params.repoRoot - Repository root path
 * @param {Array} params.changedFiles - List of changed files with path and status
 * @param {Object} params.config - Configuration object
 * @param {Object|null} [params.llm] - LLM client for semantic analysis (optional)
 * @param {string} [params.baseSha] - Base commit SHA for diff
 * @param {string} [params.headSha] - Head commit SHA for diff
 * @param {Function} [params.getFileDiff] - Function to get file diff (optional)
 * @returns {Promise<Array>} Array of drift detection results
 */
async function detectDocsDrift(params) {
  const repoRoot = params.repoRoot;
  const changedFiles = params.changedFiles;
  const config = params.config;
  const llm = params.llm;
  const baseSha = params.baseSha;
  const headSha = params.headSha;
  const getFileDiff = params.getFileDiff || defaultGetFileDiff;

  const rules = config.docsDrift.rules && config.docsDrift.rules.length > 0
    ? config.docsDrift.rules
    : [config.docsDrift];

  const results = [];

  for (const rule of rules) {
    results.push(...await runDocsRule({
      repoRoot,
      changedFiles,
      config,
      llm,
      rule,
      baseSha,
      headSha,
      getFileDiff
    }));
  }

  return results;
}

async function runDocsRule(params) {
  const repoRoot = params.repoRoot;
  const changedFiles = params.changedFiles;
  const config = params.config;
  const llm = params.llm;
  const rule = params.rule;
  const baseSha = params.baseSha;
  const headSha = params.headSha;
  const getFileDiff = params.getFileDiff;

  const codePatterns = rule.codeFiles || [];
  const docPatterns = rule.docFiles || [];
  if (codePatterns.length === 0 || docPatterns.length === 0) {
    return [];
  }

  const changedCodeFiles = changedFiles
    .map((f) => f.path)
    .filter((file) => matchAny(file, codePatterns));

  const changedDocFiles = changedFiles
    .map((f) => f.path)
    .filter((file) => matchAny(file, docPatterns));

  const scanDecision = resolveFullScan(rule, repoRoot, changedCodeFiles);

  if (!scanDecision.fullScan && changedCodeFiles.length === 0) {
    return [];
  }
  if (scanDecision.fullScan && changedCodeFiles.length === 0 && changedDocFiles.length === 0) {
    return [];
  }

  const extractList = rule.extract || [];
  const entities = [];

  const codeFilesToScan = scanDecision.codeFilesToScan;

  for (const file of codeFilesToScan) {
    const fullPath = path.resolve(repoRoot, file);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    entities.push(...extractEntities(content, file, extractList));
  }

  const needsPayloadCheck = extractList.includes('payload-keys') && baseSha && headSha;
  if (entities.length === 0 && !needsPayloadCheck) {
    return [];
  }
  const maxEntities = rule.maxEntities || DEFAULT_MAX_ENTITIES;
  const deterministicEntities = limitEntitiesByType(entities, maxEntities);
  const llmEntities = (config.llm && config.llm.enabled && llm)
    ? limitEntitiesForLlm(deterministicEntities, maxEntities)
    : [];

  const docFiles = findFiles(repoRoot, docPatterns);
  if (docFiles.length === 0) {
    return [];
  }

  const maxDocChars = rule.maxDocChars || DEFAULT_MAX_DOC_CHARS;
  const docEntries = docFiles.map((file) => {
    const fullPath = path.resolve(repoRoot, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    return {
      file,
      content: truncateText(content, maxDocChars)
    };
  });

  const docsText = docEntries.map((entry) => entry.content).join('\n\n');
  const results = [];

  if (deterministicEntities.length > 0) {
    results.push(...compareFunctions(deterministicEntities, docEntries, config, scanDecision.fullScan));
    results.push(...compareEndpoints(deterministicEntities, docEntries, config, scanDecision.fullScan));
    results.push(...compareGraphQLOperations(deterministicEntities, docEntries, config, scanDecision.fullScan));
    results.push(...compareWebSocketEvents(deterministicEntities, docEntries, config, scanDecision.fullScan));
    results.push(...compareEnvVars(deterministicEntities, docsText, config));
    results.push(...compareClasses(deterministicEntities, docsText, config));
    results.push(...compareConfigKeys(deterministicEntities, docsText, config));
    results.push(...compareCliFlags(deterministicEntities, docsText, config));
    results.push(...compareComponents(deterministicEntities, docsText, config));
    results.push(...compareDatabaseModels(deterministicEntities, docsText, config));
    results.push(...compareEventHandlers(deterministicEntities, docsText, config));
    results.push(...compareCliCommands(deterministicEntities, docsText, config));
  }

  if (llmEntities.length > 0 && config.llm && config.llm.enabled && llm) {
    const docs = docEntries.map((entry) => `FILE: ${entry.file}\n${entry.content}`).join('\n\n');
    const prompt = buildDocsDriftPrompt(llmEntities, docs);
    const response = await llm.complete(prompt);
    const data = safeParseJson(response);

    if (!data || !Array.isArray(data.drifts)) {
      results.push({
        source: 'docs-drift-llm',
        type: 'llm-parse-error',
        severity: 'warning',
        deterministic: false,
        explanation: 'LLM response could not be parsed as JSON.',
        suggestion: 'Check the prompt/output or reduce input size.'
      });
    } else {
      results.push(...data.drifts.map((drift) => ({
        source: 'docs-drift-llm',
        type: drift.type || 'docs-drift',
        severity: normalizeSeverity(drift.severity, config.output.severity.docsDrift),
        deterministic: false,
        explanation: drift.explanation || drift.summary || '',
        file: drift.file || drift.code_file || undefined,
        suggestion: drift.suggestion || ''
      })).filter((item) => item.explanation || item.suggestion || item.file));
    }
  }

  if (extractList.includes('payload-keys') && baseSha && headSha) {
    const docPayloadKeys = extractDocPayloadKeys(docEntries);
    results.push(...comparePayloadKeyRenames({
      changedCodeFiles,
      getFileDiff,
      baseSha,
      headSha,
      docPayloadKeys,
      config,
      rule
    }));
  }

  if (rule.name) {
    return results.map((result) => ({ ...result, rule: result.rule || rule.name }));
  }

  return results;
}

function resolveFullScan(rule, repoRoot, changedCodeFiles) {
  const fullScanSetting = rule.fullScan;
  const maxFiles = Number.isFinite(rule.fullScanMaxFiles)
    ? rule.fullScanMaxFiles
    : Number(rule.fullScanMaxFiles) || 200;
  const codePatterns = rule.codeFiles || [];
  const uniqueChanged = Array.from(new Set(changedCodeFiles));

  if (fullScanSetting === true) {
    const codeFilesToScan = findFiles(repoRoot, codePatterns);
    return { fullScan: true, codeFilesToScan };
  }

  if (fullScanSetting === false) {
    return { fullScan: false, codeFilesToScan: uniqueChanged };
  }

  const allCodeFiles = findFiles(repoRoot, codePatterns);
  if (allCodeFiles.length > 0 && allCodeFiles.length <= maxFiles) {
    return { fullScan: true, codeFilesToScan: allCodeFiles };
  }

  return { fullScan: false, codeFilesToScan: uniqueChanged };
}

function limitEntitiesByType(entities, maxPerType) {
  const limits = new Map();
  const limited = [];
  for (const entity of entities) {
    const type = entity.type || 'unknown';
    const count = limits.get(type) || 0;
    if (count >= maxPerType) {
      continue;
    }
    limits.set(type, count + 1);
    limited.push(entity);
  }
  return limited;
}

function limitEntitiesForLlm(entities, maxTotal) {
  if (entities.length <= maxTotal) {
    return entities;
  }
  const byType = new Map();
  for (const entity of entities) {
    const type = entity.type || 'unknown';
    const list = byType.get(type) || [];
    list.push(entity);
    byType.set(type, list);
  }

  const types = Array.from(byType.keys());
  const result = [];
  let index = 0;
  while (result.length < maxTotal) {
    let added = false;
    for (const type of types) {
      const list = byType.get(type);
      if (index < list.length) {
        result.push(list[index]);
        added = true;
        if (result.length >= maxTotal) {
          break;
        }
      }
    }
    if (!added) {
      break;
    }
    index += 1;
  }

  return result;
}

function extractEntities(content, file, extractList) {
  const results = [];

  // Validate content before extraction
  const validation = validateContent(content, file);
  if (!validation.valid) {
    console.warn(`Skipping extraction for ${file}: ${validation.reason}`);
    return results;
  }

  const ext = path.extname(file).toLowerCase();
  const include = (name) => extractList.includes(name);

  if (include('function-signatures')) {
    if (ext === '.py') {
      safeExtract(extractPythonFunctions, content, file, results, 'PythonFunctions');
    } else if (ext === '.go') {
      safeExtract(extractGoFunctions, content, file, results, 'GoFunctions');
    } else if (ext === '.rb') {
      safeExtract(extractRubyFunctions, content, file, results, 'RubyFunctions');
    } else if (ext === '.java') {
      safeExtract(extractJavaFunctions, content, file, results, 'JavaFunctions');
    } else if (ext === '.kt') {
      safeExtract(extractKotlinFunctions, content, file, results, 'KotlinFunctions');
    } else if (ext === '.cs') {
      safeExtract(extractCSharpFunctions, content, file, results, 'CSharpFunctions');
    } else {
      safeExtract(extractJsFunctions, content, file, results, 'JsFunctions');
    }
  }

  if (include('class-names')) {
    safeExtract(extractClassNames, content, file, results, 'ClassNames');
  }

  if (include('api-endpoints')) {
    safeExtract(extractEndpoints, content, file, results, 'Endpoints');
    // Also extract GraphQL operations
    safeExtract(extractGraphQLOperations, content, file, results, 'GraphQLOperations');
    // WebSocket handlers
    safeExtract(extractWebSocketHandlers, content, file, results, 'WebSocketHandlers');
  }

  if (include('env-variables')) {
    safeExtract(extractEnvVariables, content, file, results, 'EnvVariables');
  }

  if (include('config-keys')) {
    safeExtract(extractConfigKeys, content, file, results, 'ConfigKeys');
  }

  if (include('cli-flags')) {
    safeExtract(extractCliFlags, content, file, results, 'CliFlags');
    // Also extract CLI commands from popular parsers
    safeExtract(extractCliCommands, content, file, results, 'CliCommands');
  }

  // Extract event handlers (important for docs)
  if (include('function-signatures') || include('api-endpoints')) {
    safeExtract(extractEventHandlers, content, file, results, 'EventHandlers');
  }

  // Extract React/Vue components if it looks like a component file
  if (include('function-signatures') || include('class-names')) {
    safeExtract(extractComponents, content, file, results, 'Components');
  }

  // Extract database models/schemas
  if (include('class-names') || include('config-keys')) {
    safeExtract(extractDatabaseModels, content, file, results, 'DatabaseModels');
  }

  // Extract test descriptions
  if (include('function-signatures')) {
    safeExtract(extractTestDescriptions, content, file, results, 'TestDescriptions');
  }

  return results;
}

function extractJsFunctions(content, file, results) {
  const patterns = [
    // Match: [export] [default] [async] function name(params)
    // Examples: export async function fetchUsers(id, limit)
    //           export default function processData()
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g,

    // Match: [export] const/let/var name = [async] (params) =>
    // Examples: export const fetchUsers = async (id) =>
    //           const handler = (req, res) =>
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g,

    // Match: Arrow function with single param (no parens)
    // Examples: const double = x => x * 2
    //           const getId = user => user.id
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?([A-Za-z0-9_$]+)\s*=>/g,

    // Match: Class method definitions
    // Examples: async getUser(id) { }
    //           static getInstance() { }
    //           private handleError(err) { }
    /^\s*(?:async\s+)?(?:static\s+)?(?:private\s+|public\s+|protected\s+)?(?:async\s+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/gm,

    // Match: Object shorthand methods
    // Examples: { handleClick() { }, onSubmit(data) { } }
    /^\s*([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/gm,

    // Match: TypeScript method with return type
    // Examples: function getData(): Promise<User>
    //           async function fetch(): Promise<void>
    /\b(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*:\s*[A-Za-z0-9_$<>[\]|&\s]+\s*\{/g,

    // Match: Arrow with type annotation (TypeScript)
    // Examples: const fn: Handler = (req) =>
    //           const process: (x: number) => number = (x) =>
    /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*:\s*[^=]+=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      // Skip common false positives
      if (['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'new', 'throw', 'typeof', 'void', 'delete', 'in', 'of'].includes(name)) {
        continue;
      }
      // Dedupe
      const key = `${name}:${match.index}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(buildEntity('function', name, match[2] || '', file, content, match.index));
    }
  }
}

function extractPythonFunctions(content, file, results) {
  const patterns = [
    // Match: [async] def function_name(params)
    // Examples: def fetch_users(user_id, limit=10)
    //           async def get_data(session)
    /\b(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g,

    // Match: Lambda assignments
    // Examples: process = lambda x: x * 2
    //           handler = lambda event, context: process(event)
    /\b([A-Za-z0-9_]+)\s*=\s*lambda\s+([^:]+):/g
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      // Skip dunder methods for cleaner output (optional - they're valid but noisy)
      if (name.startsWith('__') && name.endsWith('__') && name !== '__init__') {
        continue;
      }
      const key = `${name}:${match.index}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(buildEntity('function', name, match[2], file, content, match.index));
    }
  }
}

function extractGoFunctions(content, file, results) {
  const patterns = [
    // Match: func [receiver] FunctionName(params)
    // Examples: func (s *Service) GetUser(id string)
    //           func ProcessData(data []byte)
    // The optional (?:\([^)]+\)\s*)? handles method receivers like (s *Service)
    /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/g,

    // Match: Generic functions (Go 1.18+)
    // Examples: func Map[T, U any](items []T, fn func(T) U) []U
    //           func (s *Service) Find[T any](id string) T
    /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)\s*\[[^\]]+\]\s*\(([^)]*)\)/g
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const key = `${match[1]}:${match.index}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(buildEntity('function', match[1], match[2], file, content, match.index));
    }
  }
}

function extractRubyFunctions(content, file, results) {
  // Match: def [self.]method_name(params)
  // Example: def self.find_user(id)
  // Ruby allows ? and ! in method names
  const parenPattern = /\bdef\s+(?:self\.)?([A-Za-z0-9_?!]+)\s*\(([^)]*)\)/g;

  // Match: def method_name arg1, arg2 (bare arguments without parens)
  // Example: def process_item item, options
  const barePattern = /\bdef\s+(?:self\.)?([A-Za-z0-9_?!]+)\s+([A-Za-z0-9_?!,\s]+)$/gm;

  let match;
  while ((match = parenPattern.exec(content)) !== null) {
    results.push(buildEntity('function', match[1], match[2], file, content, match.index));
  }
  while ((match = barePattern.exec(content)) !== null) {
    results.push(buildEntity('function', match[1], match[2], file, content, match.index));
  }
}

function extractJavaFunctions(content, file, results) {
  // Match: [modifiers] ReturnType methodName(params) { or ;
  // Example: public static List<User> findUsers(String query, int limit) {
  // Modifiers: public, protected, private, static, final, synchronized, abstract, native, strictfp
  // Return type can include generics like List<User> or arrays like String[]
  const pattern = /\b(?:public|protected|private|static|final|synchronized|abstract|native|strictfp|\s)+\s*([A-Za-z0-9_.$<>[\]]+)\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*(?:\{|;)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    results.push(buildEntity('function', match[2], match[3], file, content, match.index));
  }
}

function extractKotlinFunctions(content, file, results) {
  // Match: fun [<generics>] [Receiver.]functionName(params)
  // Example: fun <T> List<T>.findFirst(predicate: (T) -> Boolean)
  // Handles generic type parameters and extension functions
  const pattern = /\bfun\s+(?:<[^>]+>\s+)?(?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    results.push(buildEntity('function', match[1], match[2], file, content, match.index));
  }
}

function extractCSharpFunctions(content, file, results) {
  // Match: [modifiers] ReturnType MethodName(params) { or => or ;
  // Example: public async Task<User> GetUserAsync(int id) {
  // Modifiers: public, protected, private, internal, static, async, virtual, override, sealed, partial, extern
  // Supports expression-bodied members (=>) and interface declarations (;)
  const pattern = /\b(?:public|protected|private|internal|static|async|virtual|override|sealed|partial|extern|\s)+\s*([A-Za-z0-9_.$<>[\]]+)\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*(?:\{|=>|;)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    results.push(buildEntity('function', match[2], match[3], file, content, match.index));
  }
}

function extractClassNames(content, file, results) {
  const pattern = /\bclass\s+([A-Za-z0-9_]+)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    results.push(buildEntity('class', match[1], '', file, content, match.index));
  }
}

function extractEndpoints(content, file, results) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py') {
    extractPythonEndpoints(content, file, results);
    return;
  }
  if (ext === '.rb') {
    extractRubyEndpoints(content, file, results);
    return;
  }
  if (ext === '.go') {
    extractGoEndpoints(content, file, results);
    return;
  }
  if (ext === '.java' || ext === '.kt') {
    extractSpringEndpoints(content, file, results);
    return;
  }
  if (ext === '.cs') {
    extractCSharpEndpoints(content, file, results);
    return;
  }
  extractJsEndpoints(content, file, results);
}

function extractEnvVariables(content, file, results) {
  const ext = path.extname(file).toLowerCase();
  let match;
  if (ext === '.py') {
    const pyPatterns = [
      // Match: os.environ.get('VAR') or os.environ['VAR']
      // Examples: os.environ.get('API_KEY')
      //           os.environ['DATABASE_URL']
      /\bos\.environ(?:\.get)?\s*[[(]\s*['"]([A-Z0-9_]+)['"]\s*[\])]/g,

      // Match: environ.get('VAR') or environ['VAR'] (from os import environ)
      // Examples: environ.get('SECRET_KEY', 'default')
      //           environ['PORT']
      /\benviron(?:\.get)?\s*[[(]\s*['"]([A-Z0-9_]+)['"]\s*[\])]/g,

      // Match: getenv('VAR') (from os import getenv)
      // Examples: getenv('HOME')
      //           getenv('USER', 'anonymous')
      /\bgetenv\s*\(\s*['"]([A-Z0-9_]+)['"]/g,

      // Match: settings.VAR or config.VAR (Django/Flask style)
      // Examples: settings.DEBUG
      //           config.SECRET_KEY
      /\b(?:settings|config)\.([A-Z][A-Z0-9_]*)\b/g,

      // Match: pydantic BaseSettings fields
      // Examples: api_key: str = Field(env='API_KEY')
      /\benv\s*=\s*['"]([A-Z0-9_]+)['"]/g
    ];

    const seen = new Set();
    for (const pattern of pyPatterns) {
      while ((match = pattern.exec(content)) !== null) {
        if (!seen.has(match[1])) {
          seen.add(match[1]);
          results.push(buildEntity('env', match[1], '', file, content, match.index));
        }
      }
    }
    return;
  }
  if (ext === '.go') {
    const goPattern = /os\.(?:Getenv|LookupEnv)\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g;
    while ((match = goPattern.exec(content)) !== null) {
      results.push(buildEntity('env', match[1], '', file, content, match.index));
    }
    return;
  }
  if (ext === '.rb') {
    const rbPattern = /ENV(?:\.fetch)?\(\s*['"]([A-Z0-9_]+)['"]\s*(?:,|\))|ENV\s*\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g;
    while ((match = rbPattern.exec(content)) !== null) {
      const name = match[1] || match[2];
      if (name) {
        results.push(buildEntity('env', name, '', file, content, match.index));
      }
    }
    return;
  }
  if (ext === '.java' || ext === '.kt') {
    const jvmPattern = /System\.getenv\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g;
    while ((match = jvmPattern.exec(content)) !== null) {
      results.push(buildEntity('env', match[1], '', file, content, match.index));
    }
    return;
  }
  if (ext === '.cs') {
    const csPattern = /Environment\.GetEnvironmentVariable\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g;
    while ((match = csPattern.exec(content)) !== null) {
      results.push(buildEntity('env', match[1], '', file, content, match.index));
    }
    return;
  }

  // JavaScript/TypeScript environment variables
  const jsPatterns = [
    // Match: process.env.VAR_NAME
    // Examples: process.env.API_KEY
    //           process.env.NODE_ENV
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,

    // Match: process.env['VAR_NAME'] or process.env["VAR_NAME"]
    // Examples: process.env['DATABASE_URL']
    //           process.env["SECRET_KEY"]
    /\bprocess\.env\s*\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,

    // Match: Destructured env vars
    // Examples: const { API_KEY, SECRET } = process.env
    //           const { DATABASE_URL: dbUrl } = process.env
    /\bconst\s*\{\s*([A-Z][A-Z0-9_,\s:]*)\s*\}\s*=\s*process\.env/g,

    // Match: Deno.env.get('VAR')
    // Examples: Deno.env.get('API_KEY')
    /\bDeno\.env\.get\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,

    // Match: Bun.env.VAR_NAME
    // Examples: Bun.env.PORT
    /\bBun\.env\.([A-Z][A-Z0-9_]*)/g,

    // Match: import.meta.env.VITE_VAR (Vite)
    // Examples: import.meta.env.VITE_API_URL
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g
  ];

  const seen = new Set();
  for (const pattern of jsPatterns) {
    while ((match = pattern.exec(content)) !== null) {
      const envVars = match[1];
      // Handle destructured pattern - may contain multiple vars
      if (envVars.includes(',')) {
        const vars = envVars.split(',').map(v => v.split(':')[0].trim());
        for (const v of vars) {
          if (v && /^[A-Z][A-Z0-9_]*$/.test(v) && !seen.has(v)) {
            seen.add(v);
            results.push(buildEntity('env', v, '', file, content, match.index));
          }
        }
      } else {
        const v = envVars.split(':')[0].trim();
        if (v && !seen.has(v)) {
          seen.add(v);
          results.push(buildEntity('env', v, '', file, content, match.index));
        }
      }
    }
  }
}

function extractConfigKeys(content, file, results) {
  const ext = path.extname(file).toLowerCase();
  const patterns = [];

  if (ext === '.py') {
    patterns.push(/\b(?:config|settings)\.get\(\s*['"]([^'"]+)['"]\s*\)/g);
    patterns.push(/\b(?:config|settings)\s*\[\s*['"]([^'"]+)['"]\s*\]/g);
  } else if (ext === '.go') {
    patterns.push(/\b(?:viper|config|cfg)\.(?:GetString|GetInt|GetBool|GetFloat64|Get)\(\s*['"`]([^'"`]+)['"`]\s*\)/g);
  } else if (ext === '.rb') {
    patterns.push(/\b(?:config|settings)\s*\[\s*['"]([^'"]+)['"]\s*\]/g);
    patterns.push(/\b(?:config|settings)\.fetch\(\s*['"]([^'"]+)['"]\s*\)/g);
  } else if (ext === '.java' || ext === '.kt') {
    patterns.push(/\b(?:System|config)\.getProperty\(\s*['"]([^'"]+)['"]\s*\)/g);
    patterns.push(/@Value\(\s*['"]\$\{([^}]+)\}['"]\s*\)/g);
  } else if (ext === '.cs') {
    patterns.push(/\b(?:Configuration|config|settings)\s*\[\s*["']([^"']+)["']\s*\]/g);
    patterns.push(/\.GetSection\(\s*["']([^"']+)["']\s*\)/g);
  } else {
    patterns.push(/\b(?:config|settings|cfg|options)\.get\(\s*['"`]([^'"`]+)['"`]\s*\)/g);
    patterns.push(/\b(?:config|settings|cfg|options)\s*\[\s*['"`]([^'"`]+)['"`]\s*\]/g);
  }

  let match;
  for (const pattern of patterns) {
    while ((match = pattern.exec(content)) !== null) {
      results.push(buildEntity('config-key', match[1], '', file, content, match.index));
    }
  }
}

function extractCliFlags(content, file, results) {
  const pattern = /--[a-z0-9][a-z0-9-]*/gi;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    results.push(buildEntity('cli-flag', match[0], '', file, content, match.index));
  }
}

function extractJsEndpoints(content, file, results) {
  const patterns = [
    // Match: app.get('/path'), router.post('/path'), fastify.put('/path')
    // Examples: app.get('/users', handler)
    //           router.post('/api/login', authenticate)
    //           fastify.delete('/items/:id', removeItem)
    /\b(?:app|router|server|fastify|hono|elysia)\s*\.\s*(get|post|put|delete|patch|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi,

    // Match: Express .route() chaining
    // Examples: app.route('/users').get(handler).post(create)
    //           router.route('/items').get(list).delete(remove)
    /\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.\s*(get|post|put|delete|patch)/gi,

    // Match: NestJS decorators
    // Examples: @Get('/users')
    //           @Post('items')
    //           @Delete(':id')
    /@(Get|Post|Put|Delete|Patch|Options|Head)\s*\(\s*['"`]?([^'"`)\s]*)['"`]?\s*\)/gi,

    // Match: Hapi.js routes
    // Examples: { method: 'GET', path: '/users' }
    //           { method: 'POST', path: '/api/data' }
    /method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]\s*,\s*path\s*:\s*['"`]([^'"`]+)['"`]/gi,

    // Match: Koa Router
    // Examples: router.get('/path', handler)
    //           koaRouter.post('/api', controller)
    /\b(?:koaRouter|KoaRouter)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      let method, path;
      // Handle route() chaining where order is flipped
      if (pattern.source.includes('\\.route')) {
        path = match[1];
        method = match[2];
      } else {
        method = match[1];
        path = match[2] || '/';
      }
      const name = `${method.toUpperCase()} ${path}`;
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      results.push(buildEntity('endpoint', name, '', file, content, match.index));
    }
  }
}

function extractPythonEndpoints(content, file, results) {
  const decoratorPattern = /@\w+\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match;
  while ((match = decoratorPattern.exec(content)) !== null) {
    const name = `${match[1].toUpperCase()} ${match[2]}`;
    results.push(buildEntity('endpoint', name, '', file, content, match.index));
  }

  const routePattern = /@\w+\.route\s*\(\s*['"`]([^'"`]+)['"`]([^)]*)\)/g;
  while ((match = routePattern.exec(content)) !== null) {
    const routePath = match[1];
    const methods = parsePythonRouteMethods(match[2]);
    if (methods.length === 0) {
      results.push(buildEntity('endpoint', `GET ${routePath}`, '', file, content, match.index));
    } else {
      for (const method of methods) {
        results.push(buildEntity('endpoint', `${method} ${routePath}`, '', file, content, match.index));
      }
    }
  }
}

function parsePythonRouteMethods(text) {
  if (!text) {
    return [];
  }
  const methodsMatch = text.match(/methods\s*=\s*[[(]([^\])]+)[\])]/i);
  if (!methodsMatch) {
    return [];
  }
  return methodsMatch[1]
    .split(',')
    .map((value) => value.replace(/['"\s]/g, '').toUpperCase())
    .filter(Boolean);
}

function extractRubyEndpoints(content, file, results) {
  const pattern = /\b(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const name = `${match[1].toUpperCase()} ${match[2]}`;
    results.push(buildEntity('endpoint', name, '', file, content, match.index));
  }
}

function extractGoEndpoints(content, file, results) {
  const methodsPathPattern = /\.Methods\(([^)]*)\)\s*\.Path\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let match;
  while ((match = methodsPathPattern.exec(content)) !== null) {
    const methods = parseGoMethods(match[1]);
    if (methods.length === 0) {
      continue;
    }
    for (const method of methods) {
      results.push(buildEntity('endpoint', `${method} ${match[2]}`, '', file, content, match.index));
    }
  }

  const handlePattern = /\.Handle(?:Func)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((match = handlePattern.exec(content)) !== null) {
    const tail = content.slice(match.index, match.index + 200);
    const methods = parseGoMethods(tail);
    if (methods.length === 0) {
      results.push(buildEntity('endpoint', `GET ${match[1]}`, '', file, content, match.index));
      continue;
    }
    for (const method of methods) {
      results.push(buildEntity('endpoint', `${method} ${match[1]}`, '', file, content, match.index));
    }
  }

  const verbPattern = /\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  while ((match = verbPattern.exec(content)) !== null) {
    const name = `${match[1].toUpperCase()} ${match[2]}`;
    results.push(buildEntity('endpoint', name, '', file, content, match.index));
  }
}

function parseGoMethods(text) {
  if (!text) {
    return [];
  }
  const methods = [];
  const methodPattern = /['"]([A-Za-z]+)['"]/g;
  let match;
  while ((match = methodPattern.exec(text)) !== null) {
    const method = match[1].toUpperCase();
    if (!methods.includes(method)) {
      methods.push(method);
    }
  }
  return methods;
}

function extractSpringEndpoints(content, file, results) {
  const mappingPattern = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(([^)]*)\)/g;
  let match;
  while ((match = mappingPattern.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const pathValue = parseSpringPath(match[2]);
    if (pathValue) {
      results.push(buildEntity('endpoint', `${method} ${pathValue}`, '', file, content, match.index));
    }
  }

  const requestMappingPattern = /@RequestMapping\s*\(([^)]*)\)/g;
  while ((match = requestMappingPattern.exec(content)) !== null) {
    const pathValue = parseSpringPath(match[1]);
    const methods = parseSpringMethods(match[1]);
    if (!pathValue) {
      continue;
    }
    if (methods.length === 0) {
      results.push(buildEntity('endpoint', `GET ${pathValue}`, '', file, content, match.index));
      continue;
    }
    for (const method of methods) {
      results.push(buildEntity('endpoint', `${method} ${pathValue}`, '', file, content, match.index));
    }
  }
}

function parseSpringPath(text) {
  if (!text) {
    return '';
  }
  const named = text.match(/\b(?:path|value)\s*=\s*['"]([^'"]+)['"]/);
  if (named) {
    return named[1];
  }
  const direct = text.match(/^\s*['"]([^'"]+)['"]/);
  if (direct) {
    return direct[1];
  }
  return '';
}

function parseSpringMethods(text) {
  if (!text) {
    return [];
  }
  const methods = [];
  const pattern = /RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (!methods.includes(match[1])) {
      methods.push(match[1]);
    }
  }
  return methods;
}

function extractCSharpEndpoints(content, file, results) {
  const pattern = /\[(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch)\s*(?:\(\s*['"]([^'"]+)['"]\s*\))?\s*\]/gi;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const method = match[1].replace('Http', '').toUpperCase();
    const route = match[2];
    if (!route) {
      continue;
    }
    results.push(buildEntity('endpoint', `${method} ${route}`, '', file, content, match.index));
  }
}

function buildEntity(type, name, params, file, content, index) {
  const signature = params ? `${name}(${params.split(',').map((p) => p.trim()).filter(Boolean).join(', ')})` : name;
  return {
    type,
    name,
    signature,
    file,
    line: getLineNumber(content, index)
  };
}

function getLineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function compareFunctions(entities, docEntries, config, fullScan) {
  const results = [];
  const codeFunctions = entities.filter((entity) => entity.type === 'function');
  if (codeFunctions.length === 0) {
    return results;
  }

  const docFunctions = extractDocFunctions(docEntries);
  const docByName = new Map();
  for (const docFn of docFunctions) {
    const params = normalizeParamList(docFn.params);
    const entry = docByName.get(docFn.name) || [];
    entry.push({ params, file: docFn.file, signature: docFn.signature });
    docByName.set(docFn.name, entry);
  }

  const codeNames = new Set();
  const seen = new Set();

  for (const fn of codeFunctions) {
    codeNames.add(fn.name);
    const codeParams = normalizeParamList(extractSignatureParams(fn.signature));
    const codeKey = paramKey(codeParams);
    const docVariants = docByName.get(fn.name);
    const seenKey = `${fn.name}:${codeKey}`;
    if (seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);

    if (!docVariants || docVariants.length === 0) {
      results.push({
        source: 'docs-drift',
        type: 'function-missing-doc',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: fn.file,
        explanation: `Function ${fn.signature} is not documented.`,
        suggestion: 'Add or update docs to include this function.'
      });
      continue;
    }

    if (docVariants.some((variant) => paramKey(variant.params) === codeKey)) {
      continue;
    }

    const best = chooseBestParamMatch(codeParams, docVariants);
    const missing = difference(codeParams, best.params);
    const extra = difference(best.params, codeParams);

    if (missing.length > 0 && extra.length === 0) {
      results.push({
        source: 'docs-drift',
        type: 'function-missing-params',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: fn.file,
        explanation: `Docs for ${fn.name} are missing params: ${missing.join(', ')}.`,
        suggestion: 'Update docs to include the missing parameters.'
      });
    } else if (extra.length > 0 && missing.length === 0) {
      results.push({
        source: 'docs-drift',
        type: 'function-extra-params',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: fn.file,
        explanation: `Docs for ${fn.name} include removed params: ${extra.join(', ')}.`,
        suggestion: 'Update docs to remove parameters that no longer exist.'
      });
    } else {
      results.push({
        source: 'docs-drift',
        type: 'function-signature-mismatch',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: fn.file,
        explanation: `Docs mention ${best.signature} but code uses ${fn.signature}.`,
        suggestion: 'Update docs or code to align parameters.'
      });
    }
  }

  if (fullScan) {
    const docSeen = new Set();
    for (const docFn of docFunctions) {
      if (codeNames.has(docFn.name)) {
        continue;
      }
      if (docSeen.has(docFn.name)) {
        continue;
      }
      docSeen.add(docFn.name);
      results.push({
        source: 'docs-drift',
        type: 'docs-mentions-missing-function',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: docFn.file,
        explanation: `Docs mention ${docFn.signature} but no matching code was found.`,
        suggestion: 'Remove or update the docs, or restore the missing function.'
      });
    }
  }

  return results;
}

function compareEndpoints(entities, docEntries, config, fullScan) {
  const results = [];
  const codeEndpoints = entities.filter((entity) => entity.type === 'endpoint');
  if (codeEndpoints.length === 0) {
    return results;
  }

  const docEndpoints = extractDocEndpoints(docEntries);
  const docMap = new Map();
  const docEndpointSet = new Set();

  for (const doc of docEndpoints) {
    const normalizedPath = normalizePath(doc.path);
    const key = `${doc.method} ${normalizedPath}`;
    docEndpointSet.add(key);
    const entry = docMap.get(normalizedPath) || new Set();
    entry.add(doc.method);
    docMap.set(normalizedPath, entry);
  }

  const codeEndpointSet = new Set();
  const seen = new Set();
  for (const endpoint of codeEndpoints) {
    const parsed = parseEndpointName(endpoint.name);
    if (!parsed) {
      continue;
    }
    const normalizedPath = normalizePath(parsed.path);
    const key = `${parsed.method} ${normalizedPath}`;
    codeEndpointSet.add(key);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const docMethods = docMap.get(normalizedPath);
    if (!docMethods) {
      results.push({
        source: 'docs-drift',
        type: 'endpoint-missing-doc',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: endpoint.file,
        explanation: `Endpoint ${parsed.method} ${parsed.path} is not documented.`,
        suggestion: 'Update docs to include this endpoint.'
      });
      continue;
    }

    if (!docMethods.has(parsed.method)) {
      results.push({
        source: 'docs-drift',
        type: 'endpoint-method-mismatch',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: endpoint.file,
        explanation: `Docs list ${Array.from(docMethods).join(', ')} for ${parsed.path}, but code uses ${parsed.method}.`,
        suggestion: 'Align the documented method with code.'
      });
    }
  }

  if (fullScan) {
    for (const doc of docEndpoints) {
      const normalizedPath = normalizePath(doc.path);
      const key = `${doc.method} ${normalizedPath}`;
      if (codeEndpointSet.has(key)) {
        continue;
      }
      results.push({
        source: 'docs-drift',
        type: 'docs-mentions-missing-endpoint',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: doc.file,
        explanation: `Docs mention ${doc.method} ${doc.path} but no matching code was found.`,
        suggestion: 'Remove or update the docs, or restore the endpoint.'
      });
    }
  }

  return results;
}

function compareGraphQLOperations(entities, docEntries, config, fullScan) {
  const results = [];
  const codeOps = entities.filter((entity) => entity.type === 'graphql-operation');
  if (codeOps.length === 0) {
    return results;
  }

  const docOps = extractDocGraphQLOperations(docEntries);
  const docMap = new Map();
  const docWildcard = new Map();

  for (const docOp of docOps) {
    const opType = normalizeGraphQLOpType(docOp.opType);
    const name = docOp.name;
    if (!name) {
      continue;
    }
    if (opType) {
      const key = `${opType}:${name}`;
      const entry = docMap.get(key) || new Set();
      entry.add(docOp.file);
      docMap.set(key, entry);
    } else {
      const entry = docWildcard.get(name) || new Set();
      entry.add(docOp.file);
      docWildcard.set(name, entry);
    }
  }

  const codeSet = new Set();
  for (const op of codeOps) {
    const opType = normalizeGraphQLOpType(op.opType) || normalizeGraphQLOpType(op.signature.split(' ')[0]);
    const name = op.name;
    if (!opType || !name) {
      continue;
    }
    const key = `${opType}:${name}`;
    codeSet.add(key);
    if (docMap.has(key) || docWildcard.has(name)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'graphql-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: op.file,
      explanation: `GraphQL ${opType} ${name} is not documented.`,
      suggestion: 'Add the operation to API docs or update the schema documentation.'
    });
  }

  if (fullScan) {
    for (const [key, files] of docMap.entries()) {
      if (codeSet.has(key)) {
        continue;
      }
      const [opType, name] = key.split(':');
      results.push({
        source: 'docs-drift',
        type: 'docs-mentions-missing-graphql',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: Array.from(files)[0],
        explanation: `Docs mention GraphQL ${opType} ${name} but no matching resolver was found.`,
        suggestion: 'Remove or update the docs, or add the missing resolver.'
      });
    }
  }

  return results;
}

function compareWebSocketEvents(entities, docEntries, config, fullScan) {
  const results = [];
  const codeEvents = entities.filter((entity) => entity.type === 'ws-event');
  if (codeEvents.length === 0) {
    return results;
  }

  const docEvents = extractDocWebSocketEvents(docEntries);
  const docMap = new Map();
  for (const docEvent of docEvents) {
    const key = normalizeWebSocketEventName(docEvent.name).toLowerCase();
    if (!key) {
      continue;
    }
    const entry = docMap.get(key) || new Set();
    entry.add(docEvent.file);
    docMap.set(key, entry);
  }

  const codeSet = new Set();
  for (const event of codeEvents) {
    const key = normalizeWebSocketEventName(event.name).toLowerCase();
    if (!key) {
      continue;
    }
    codeSet.add(key);
    if (docMap.has(key)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'ws-event-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: event.file,
      explanation: `WebSocket event ${event.name} is not documented.`,
      suggestion: 'Add the event to WebSocket docs or update client integration guides.'
    });
  }

  if (fullScan) {
    for (const [key, files] of docMap.entries()) {
      if (codeSet.has(key)) {
        continue;
      }
      results.push({
        source: 'docs-drift',
        type: 'docs-mentions-missing-ws-event',
        severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
        deterministic: true,
        file: Array.from(files)[0],
        explanation: `Docs mention WebSocket event ${key} but no matching handler was found.`,
        suggestion: 'Remove or update the docs, or add the missing handler.'
      });
    }
  }

  return results;
}

function compareEnvVars(entities, docsText, config) {
  const results = [];
  const envVars = entities.filter((entity) => entity.type === 'env');
  if (envVars.length === 0) {
    return results;
  }

  const seen = new Set();
  for (const envVar of envVars) {
    if (seen.has(envVar.name)) {
      continue;
    }
    seen.add(envVar.name);
    if (includesWord(docsText, envVar.name)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'env-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: envVar.file,
      explanation: `Environment variable ${envVar.name} is not documented.`,
      suggestion: 'Add it to setup or configuration docs.'
    });
  }

  return results;
}

function compareClasses(entities, docsText, config) {
  const results = [];
  const classes = entities.filter((entity) => entity.type === 'class');
  if (classes.length === 0) {
    return results;
  }

  const seen = new Set();
  for (const cls of classes) {
    if (seen.has(cls.name)) {
      continue;
    }
    seen.add(cls.name);
    if (includesWord(docsText, cls.name)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'class-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: cls.file,
      explanation: `Class ${cls.name} is not documented.`,
      suggestion: 'Add or update docs to include this class.'
    });
  }

  return results;
}

function compareConfigKeys(entities, docsText, config) {
  const results = [];
  const configKeys = entities.filter((entity) => entity.type === 'config-key');
  if (configKeys.length === 0) {
    return results;
  }

  const seen = new Set();
  for (const key of configKeys) {
    if (seen.has(key.name)) {
      continue;
    }
    seen.add(key.name);
    if (includesConfigKey(docsText, key.name)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'config-key-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: key.file,
      explanation: `Config key ${key.name} is not documented.`,
      suggestion: 'Add it to configuration or setup docs.'
    });
  }

  return results;
}

function compareCliFlags(entities, docsText, config) {
  const results = [];
  const flags = entities.filter((entity) => entity.type === 'cli-flag');
  if (flags.length === 0) {
    return results;
  }

  const seen = new Set();
  for (const flag of flags) {
    const normalized = flag.name.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (docsText.toLowerCase().includes(normalized)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'cli-flag-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: flag.file,
      explanation: `CLI flag ${flag.name} is not documented.`,
      suggestion: 'Add it to CLI usage docs.'
    });
  }

  return results;
}

function compareComponents(entities, docsText, config) {
  const results = [];
  const components = entities.filter((entity) => entity.type === 'component');
  if (components.length === 0) {
    return results;
  }

  const seen = new Set();
  const docsLower = docsText.toLowerCase();
  for (const component of components) {
    // Extract just the component name from "Component: UserProfile"
    const name = component.name.replace(/^Component:\s*/i, '');
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    // Check for component name in docs (case-insensitive)
    if (docsLower.includes(normalized)) {
      continue;
    }
    // Also check for kebab-case version (my-component)
    const kebabCase = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    if (docsLower.includes(kebabCase)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'component-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: component.file,
      explanation: `Component ${name} is not documented.`,
      suggestion: 'Add component documentation or storybook entry.'
    });
  }

  return results;
}

function compareDatabaseModels(entities, docsText, config) {
  const results = [];
  const models = entities.filter((entity) => entity.type === 'model');
  if (models.length === 0) {
    return results;
  }

  const seen = new Set();
  const docsLower = docsText.toLowerCase();
  for (const model of models) {
    // Extract just the model name from "Model: User"
    const name = model.name.replace(/^Model:\s*/i, '');
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (docsLower.includes(normalized)) {
      continue;
    }
    // Also check for snake_case version
    const snakeCase = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    if (docsLower.includes(snakeCase)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'model-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: model.file,
      explanation: `Database model ${name} is not documented.`,
      suggestion: 'Add model to database schema documentation.'
    });
  }

  return results;
}

function compareEventHandlers(entities, docsText, config) {
  const results = [];
  const events = entities.filter((entity) => entity.type === 'event');
  if (events.length === 0) {
    return results;
  }

  const seen = new Set();
  const docsLower = docsText.toLowerCase();
  for (const event of events) {
    // Extract just the event name from "Event: click" or "Event: user:created"
    const name = event.name.replace(/^Event:\s*/i, '');
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (docsLower.includes(normalized)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'event-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'info'),
      deterministic: true,
      file: event.file,
      explanation: `Event handler for "${name}" is not documented.`,
      suggestion: 'Document event in API or integration docs.'
    });
  }

  return results;
}

function compareTestDescriptions(entities, docsText, config) {
  // Tests are informational only - we don't require them to be documented
  // But we can flag if a documented test no longer exists
  return [];
}

function compareCliCommands(entities, docsText, config) {
  const results = [];
  const commands = entities.filter((entity) => entity.type === 'cli');
  if (commands.length === 0) {
    return results;
  }

  const seen = new Set();
  const docsLower = docsText.toLowerCase();
  for (const cmd of commands) {
    // Extract just the command name from "CLI: deploy <app>"
    // Strip argument placeholders like <app>, [options], etc.
    const name = cmd.name.replace(/^CLI:\s*/i, '');
    // Get just the first word (the actual command name)
    const cmdName = name.split(/[\s<[]/)[0];
    const normalized = cmdName.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (docsLower.includes(normalized)) {
      continue;
    }
    results.push({
      source: 'docs-drift',
      type: 'cli-command-missing-doc',
      severity: normalizeSeverity(config.output.severity.docsDrift, 'warning'),
      deterministic: true,
      file: cmd.file,
      explanation: `CLI command "${cmdName}" is not documented.`,
      suggestion: 'Add command to CLI usage documentation.'
    });
  }

  return results;
}

function extractDocFunctions(docEntries) {
  const results = [];
  const ignored = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'def'
  ]);

  for (const entry of docEntries) {
    const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
    let match;
    while ((match = pattern.exec(entry.content)) !== null) {
      const name = match[1];
      if (ignored.has(name)) {
        continue;
      }
      const params = match[2] || '';
      const signature = `${name}(${params})`;
      results.push({ name, params, signature, file: entry.file });
    }
  }

  return results;
}

function extractDocEndpoints(docEntries) {
  const results = [];
  const pattern = /\b(GET|POST|PUT|PATCH|DELETE)\s+([^\s`"'()]+)/gi;
  for (const entry of docEntries) {
    let match;
    while ((match = pattern.exec(entry.content)) !== null) {
      const method = match[1].toUpperCase();
      const pathValue = match[2];
      if (!pathValue.startsWith('/')) {
        continue;
      }
      results.push({ method, path: pathValue, file: entry.file });
    }
  }
  return results;
}

function extractDocGraphQLOperations(docEntries) {
  const results = [];
  const seen = new Set();

  for (const entry of docEntries) {
    const content = entry.content;

    const labelPattern = /\bGraphQL\s*(Query|Mutation|Subscription)?\s*[:-]\s*([A-Za-z_][A-Za-z0-9_]*)/gi;
    let match;
    while ((match = labelPattern.exec(content)) !== null) {
      const opType = normalizeGraphQLOpType(match[1]);
      const name = match[2];
      const key = `${opType || 'any'}:${name}:${entry.file}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({ opType: opType || '', name, file: entry.file });
    }

    const blocks = extractFencedBlocks(content, new Set(['graphql', 'gql', 'graphqls']));
    for (const block of blocks) {
      extractGraphQLOperationsFromSDL(block, (opType, opName) => {
        const key = `${opType}:${opName}:${entry.file}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        results.push({ opType: normalizeGraphQLOpType(opType), name: opName, file: entry.file });
      });

      extractGraphQLSelectionsFromOperations(block, (opType, fieldName) => {
        const key = `${opType}:${fieldName}:${entry.file}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        results.push({ opType: normalizeGraphQLOpType(opType), name: fieldName, file: entry.file });
      });
    }
  }

  return results;
}

function extractDocWebSocketEvents(docEntries) {
  const results = [];
  const seen = new Set();
  const labelPattern = /\b(?:WS|WebSocket|Socket)\s*(?:event)?\s*[:-]\s*([A-Za-z0-9_:-]+)/gi;
  const patterns = [
    /\b(?:socket|io|ws|connection)\s*\.\s*(?:on|once|emit)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /\b(?:ws|websocket|socket)\s*\.\s*addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /\b(?:ws|websocket|socket)\s*\.\s*(onopen|onclose|onmessage|onerror)\s*=/gi,
    /\b(?:wss|WebSocketServer)\s*\.\s*on\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /\bsubscriptions\.create\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /\bchannel\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /\b(?:connection|hubConnection)\s*\.\s*(?:on|invoke)\s*\(\s*['"`]([^'"`]+)['"`]/gi
  ];

  for (const entry of docEntries) {
    let match;
    while ((match = labelPattern.exec(entry.content)) !== null) {
      const eventName = normalizeWebSocketEventName(match[1]);
      const key = `${eventName}:${entry.file}`;
      if (!eventName || seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({ name: eventName, file: entry.file });
    }

    for (const pattern of patterns) {
      while ((match = pattern.exec(entry.content)) !== null) {
        const eventName = normalizeWebSocketEventName(match[1]);
        const key = `${eventName}:${entry.file}`;
        if (!eventName || seen.has(key)) {
          continue;
        }
        seen.add(key);
        results.push({ name: eventName, file: entry.file });
      }
    }
  }

  return results;
}

function extractSignatureParams(signature) {
  const match = signature.match(/\((.*)\)/);
  return match ? match[1] : '';
}

function normalizeParamList(text) {
  if (!text) {
    return [];
  }
  return splitParams(text)
    .map((param) => normalizeParamName(param))
    .filter(Boolean);
}

function normalizeParamName(text) {
  if (!text) {
    return '';
  }
  let cleaned = text.trim();
  if (!cleaned) {
    return '';
  }
  cleaned = cleaned.replace(/^\.\.\./, '');
  cleaned = cleaned.replace(/[?]/g, '');
  cleaned = cleaned.split('=')[0].trim();
  if (!cleaned) {
    return '';
  }
  if (cleaned.includes(':')) {
    cleaned = cleaned.split(':')[0].trim();
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return stripToken(tokens[0]);
  }

  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (isGoTypeToken(last)) {
    return stripToken(first);
  }
  if (isTypeToken(first) && !isTypeToken(last)) {
    return stripToken(last);
  }
  if (isTypeToken(last) && !isTypeToken(first)) {
    return stripToken(first);
  }
  return stripToken(last);
}

function stripToken(token) {
  return token.replace(/^[.\s]+/, '').replace(/[^A-Za-z0-9_$-]/g, '');
}

function isGoTypeToken(token) {
  if (!token) {
    return false;
  }
  const normalized = token.replace(/[,)]/g, '');
  const goTypes = new Set([
    'string', 'int', 'int64', 'int32', 'int16', 'int8',
    'uint', 'uint64', 'uint32', 'uint16', 'uint8',
    'float64', 'float32', 'bool', 'error', 'byte', 'rune', 'any'
  ]);
  if (goTypes.has(normalized)) {
    return true;
  }
  if (normalized.startsWith('[]') || normalized.startsWith('map[') || normalized.startsWith('*')) {
    return true;
  }
  if (normalized.includes('.') || normalized.includes('[') || normalized.includes(']')) {
    return true;
  }
  return false;
}

function isTypeToken(token) {
  if (!token) {
    return false;
  }
  const normalized = token.replace(/[,)]/g, '');
  if (normalized.startsWith('[]') || normalized.startsWith('*') || normalized.startsWith('map[')) {
    return true;
  }
  if (/[.<>[\]]/.test(normalized)) {
    return true;
  }
  return /^[A-Z]/.test(normalized);
}

function parseEndpointName(name) {
  if (!name) {
    return null;
  }
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  return {
    method: parts[0].toUpperCase(),
    path: parts.slice(1).join(' ')
  };
}

function paramKey(params) {
  return params.join(',');
}

function chooseBestParamMatch(codeParams, docVariants) {
  let best = docVariants[0];
  let bestScore = -1;
  for (const variant of docVariants) {
    const overlap = intersectionSize(codeParams, variant.params);
    const totalDiff = difference(codeParams, variant.params).length + difference(variant.params, codeParams).length;
    const score = overlap * 2 - totalDiff;
    if (score > bestScore) {
      bestScore = score;
      best = variant;
    }
  }
  return best;
}

function intersectionSize(a, b) {
  const setB = new Set(b);
  let count = 0;
  for (const item of a) {
    if (setB.has(item)) {
      count += 1;
    }
  }
  return count;
}

function difference(a, b) {
  const setB = new Set(b);
  return a.filter((item) => !setB.has(item));
}

function normalizePath(pathValue) {
  if (!pathValue) {
    return '';
  }
  let normalized = pathValue.trim();
  normalized = normalized.replace(/\/+$/, '');
  normalized = normalized.replace(/\{[^}]+\}/g, ':param');
  normalized = normalized.replace(/:[^/]+/g, ':param');
  if (normalized === '') {
    normalized = '/';
  }
  return normalized;
}

function includesWord(text, word) {
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`);
  return pattern.test(text);
}

function includesConfigKey(text, key) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(key)}($|[^A-Za-z0-9_])`);
  return pattern.test(text);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function splitParams(text) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(' || char === '[' || char === '{' || char === '<') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}' || char === '>') {
      depth = Math.max(0, depth - 1);
    }
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function extractDocPayloadKeys(docEntries) {
  const keyMap = new Map();
  for (const entry of docEntries) {
    const lines = entry.content.split('\n');
    for (const line of lines) {
      const keys = extractPayloadKeysFromLine(line);
      for (const key of keys) {
        if (!keyMap.has(key)) {
          keyMap.set(key, new Set());
        }
        keyMap.get(key).add(entry.file);
      }
    }
  }
  return keyMap;
}

function comparePayloadKeyRenames(params) {
  const results = [];
  const changedCodeFiles = params.changedCodeFiles || [];
  const getFileDiff = params.getFileDiff;
  const baseSha = params.baseSha;
  const headSha = params.headSha;
  const docPayloadKeys = params.docPayloadKeys || new Map();
  const config = params.config;
  const rule = params.rule || {};
  const allowlist = compileAllowlist(rule.payloadKeysAllowlist || config.docsDrift.payloadKeysAllowlist || []);
  const severity = normalizeSeverity(config.output.severity.docsDrift, 'warning');

  for (const file of changedCodeFiles) {
    const diff = getFileDiff(baseSha, headSha, file);
    if (!diff) {
      continue;
    }
    const renames = findPayloadKeyRenames(diff, allowlist);
    for (const rename of renames) {
      if (!docPayloadKeys.has(rename.oldKey)) {
        continue;
      }
      if (docPayloadKeys.has(rename.newKey)) {
        continue;
      }
      const docFiles = Array.from(docPayloadKeys.get(rename.oldKey) || []).slice(0, 3);
      const docHint = docFiles.length > 0
        ? ` Docs mention ${rename.oldKey} in ${docFiles.join(', ')}.`
        : '';
      results.push({
        source: 'docs-drift',
        type: 'payload-key-rename',
        severity,
        deterministic: true,
        file,
        explanation: `Payload key renamed from ${rename.oldKey} to ${rename.newKey}.${docHint}`,
        suggestion: 'Update docs to use the new payload field name or preserve a compatibility alias.'
      });
    }
  }

  return results;
}

function findPayloadKeyRenames(diffText, allowlist) {
  const renames = [];
  let removed = [];
  let added = [];

  const finalizeHunk = () => {
    if (removed.length === 0 && added.length === 0) {
      return;
    }
    const uniqueRemoved = uniqueKeys(removed);
    const uniqueAdded = uniqueKeys(added);
    if (uniqueRemoved.length === 1 && uniqueAdded.length === 1) {
      const oldKey = uniqueRemoved[0];
      const newKey = uniqueAdded[0];
      if (oldKey !== newKey && (matchesAllowlist(oldKey, allowlist) || matchesAllowlist(newKey, allowlist))) {
        renames.push({ oldKey, newKey });
      }
    }
    removed = [];
    added = [];
  };

  const lines = diffText.split('\n');
  for (const line of lines) {
    if (line.startsWith('@@')) {
      finalizeHunk();
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added.push(...extractPayloadKeysFromLine(line.slice(1)));
      continue;
    }
    if (line.startsWith('-')) {
      removed.push(...extractPayloadKeysFromLine(line.slice(1)));
    }
  }
  finalizeHunk();

  return renames;
}

function extractPayloadKeysFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
    return [];
  }
  if (trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return [];
  }
  if (/^(case|default)\b/.test(trimmed)) {
    return [];
  }

  const keys = [];
  const pushKey = (key) => {
    if (!key) {
      return;
    }
    const cleaned = key.trim();
    if (!cleaned || cleaned === '-') {
      return;
    }
    if (/^\d+$/.test(cleaned)) {
      return;
    }
    keys.push(cleaned);
  };

  let match;
  const quotedKeyPattern = /["'`]([A-Za-z0-9_.-]+)["'`]\s*:/g;
  while ((match = quotedKeyPattern.exec(line)) !== null) {
    pushKey(match[1]);
  }

  const unquotedKeyPattern = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*:/g;
  const unquotedTarget = stripStringLiterals(line);
  while ((match = unquotedKeyPattern.exec(unquotedTarget)) !== null) {
    const key = match[1];
    if (!key || EXCLUDED_PAYLOAD_KEYS.has(key)) {
      continue;
    }
    pushKey(key);
  }

  const jsonTagPattern = /\bjson\s*:\s*["']([^,"']+)/g;
  while ((match = jsonTagPattern.exec(line)) !== null) {
    pushKey(match[1]);
  }

  const annotationPattern = /(?:@|\[)\s*(?:JsonProperty(?:Name)?|SerializedName)\s*\(([^)]*)\)/g;
  while ((match = annotationPattern.exec(line)) !== null) {
    const args = match[1] || '';
    const literal = args.match(/["']([^"']+)["']/);
    if (literal) {
      pushKey(literal[1]);
    }
  }

  return uniqueKeys(keys);
}

function uniqueKeys(keys) {
  return Array.from(new Set(keys));
}

function stripStringLiterals(line) {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (escaped) {
      escaped = false;
      result += ' ';
      continue;
    }
    if (char === '\\') {
      escaped = true;
      result += ' ';
      continue;
    }
    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      }
      result += ' ';
      continue;
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false;
      }
      result += ' ';
      continue;
    }
    if (inBacktick) {
      if (char === '`') {
        inBacktick = false;
      }
      result += ' ';
      continue;
    }
    if (char === "'") {
      inSingle = true;
      result += ' ';
      continue;
    }
    if (char === '"') {
      inDouble = true;
      result += ' ';
      continue;
    }
    if (char === '`') {
      inBacktick = true;
      result += ' ';
      continue;
    }
    result += char;
  }

  return result;
}

function compileAllowlist(allowlist) {
  if (!allowlist || allowlist.length === 0) {
    return [];
  }
  const matchers = [];
  for (const entry of allowlist) {
    if (!entry) {
      continue;
    }
    if (entry instanceof RegExp) {
      matchers.push(entry);
      continue;
    }
    const raw = String(entry).trim();
    if (!raw) {
      continue;
    }
    if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
      const lastSlash = raw.lastIndexOf('/');
      const body = raw.slice(1, lastSlash);
      const flags = raw.slice(lastSlash + 1);
      matchers.push(new RegExp(body, flags));
      continue;
    }
    if (raw.includes('*') || raw.includes('?')) {
      matchers.push(wildcardToRegExp(raw));
      continue;
    }
    matchers.push(new RegExp(`^${escapeRegExp(raw)}$`));
  }
  return matchers;
}

function matchesAllowlist(key, allowlist) {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  return allowlist.some((matcher) => matcher.test(key));
}

function wildcardToRegExp(value) {
  const escaped = value.replace(/[-/\\^$+?.()|\\[\]{}]/g, '\\$&');
  const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regex}$`);
}

// ============================================================================
// Additional Entity Extractors - Real-world patterns developers actually use
// ============================================================================

const GRAPHQL_INTERNAL_FIELDS = new Set([
  '__resolveType',
  '__isTypeOf',
  '__typename'
]);

function extractGraphQLOperations(content, file, results) {
  if (!looksLikeGraphQLContent(content, file)) {
    return;
  }
  const seen = new Set();

  const addOperation = (opType, opName, index) => {
    const normalizedType = normalizeGraphQLOpType(opType);
    if (!normalizedType || !opName) {
      return;
    }
    if (GRAPHQL_INTERNAL_FIELDS.has(opName)) {
      return;
    }
    const key = `${normalizedType}:${opName}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(buildGraphQLEntity(normalizedType, opName, file, content, index));
  };

  // Resolver assignment: resolvers.Query.user = ...
  const assignmentPattern = /\bresolvers\.(Query|Mutation|Subscription)\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  let match;
  while ((match = assignmentPattern.exec(content)) !== null) {
    addOperation(match[1], match[2], match.index);
  }

  // Resolver map blocks: Query: { user: ... }
  const mapPattern = /\b(Query|Mutation|Subscription)\s*:\s*\{/g;
  while ((match = mapPattern.exec(content)) !== null) {
    const opType = match[1];
    const braceIndex = content.indexOf('{', match.index);
    const block = extractBracedBlock(content, braceIndex);
    if (!block) {
      continue;
    }
    const fields = extractGraphQLFieldNames(block.block);
    for (const field of fields) {
      addOperation(opType, field.name, braceIndex + 1 + field.index);
    }
  }

  // Decorators: @Query() methodName(...) { }
  const decoratorPattern = /@(Query|Mutation|Subscription)\s*\([^)]*\)\s*(?:\r?\n\s*)?(?:public|private|protected|static\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  while ((match = decoratorPattern.exec(content)) !== null) {
    addOperation(match[1], match[2], match.index);
  }

  // SDL blocks: type Query { ... }
  extractGraphQLOperationsFromSDL(content, (opType, opName, index) => {
    addOperation(opType, opName, index);
  });
}

function looksLikeGraphQLContent(content, file) {
  const ext = path.extname(file).toLowerCase();
  if (['.graphql', '.gql', '.graphqls'].includes(ext)) {
    return true;
  }
  return /\b(graphql|gql|typeDefs|resolvers|ApolloServer|makeExecutableSchema|GraphQLSchema|@Resolver|@Query|@Mutation|@Subscription)\b/.test(content);
}

function normalizeGraphQLOpType(value) {
  if (!value) {
    return '';
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'query') {
    return 'Query';
  }
  if (normalized === 'mutation') {
    return 'Mutation';
  }
  if (normalized === 'subscription') {
    return 'Subscription';
  }
  return '';
}

function buildGraphQLEntity(opType, opName, file, content, index) {
  return {
    type: 'graphql-operation',
    name: opName,
    opType,
    signature: `${opType} ${opName}`,
    file,
    line: getLineNumber(content, index)
  };
}

function buildWebSocketEntity(eventName, file, content, index) {
  return {
    type: 'ws-event',
    name: eventName,
    signature: eventName,
    file,
    line: getLineNumber(content, index)
  };
}

function extractGraphQLOperationsFromSDL(content, onOperation) {
  const typePattern = /\b(?:type|extend\s+type)\s+(Query|Mutation|Subscription)\s*\{/g;
  let match;
  while ((match = typePattern.exec(content)) !== null) {
    const opType = match[1];
    const braceIndex = content.indexOf('{', match.index);
    const block = extractBracedBlock(content, braceIndex);
    if (!block) {
      continue;
    }
    const fields = extractGraphQLFieldNames(block.block);
    for (const field of fields) {
      onOperation(opType, field.name, braceIndex + 1 + field.index);
    }
  }
}

function extractGraphQLFieldNames(block) {
  const fields = [];
  const pattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:/gm;
  let match;
  while ((match = pattern.exec(block)) !== null) {
    const name = match[1];
    if (!name || GRAPHQL_INTERNAL_FIELDS.has(name)) {
      continue;
    }
    fields.push({ name, index: match.index });
  }
  return fields;
}

function extractBracedBlock(content, startIndex) {
  if (startIndex < 0 || startIndex >= content.length) {
    return null;
  }
  let index = startIndex;
  while (index < content.length && content[index] !== '{') {
    index += 1;
  }
  if (index >= content.length) {
    return null;
  }
  let depth = 0;
  const start = index;
  for (let i = start; i < content.length; i += 1) {
    const char = content[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          block: content.slice(start + 1, i),
          endIndex: i
        };
      }
    }
  }
  return null;
}

function extractFencedBlocks(content, languages) {
  const blocks = [];
  const pattern = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    if (languages.has(lang)) {
      blocks.push(match[2]);
    }
  }
  return blocks;
}

function extractGraphQLSelectionsFromOperations(content, onField) {
  const opPattern = /\b(query|mutation|subscription)\b/gi;
  let match;
  while ((match = opPattern.exec(content)) !== null) {
    const opType = match[1];
    const prefix = content.slice(Math.max(0, match.index - 20), match.index);
    if (/\btype\s*$/i.test(prefix) || /\bextend\s+type\s*$/i.test(prefix)) {
      continue;
    }
    const braceIndex = content.indexOf('{', match.index);
    const block = extractBracedBlock(content, braceIndex);
    if (!block) {
      continue;
    }
    const fields = extractGraphQLSelectionFields(block.block);
    for (const field of fields) {
      onField(opType, field);
    }
  }
}

function extractGraphQLSelectionFields(block) {
  const fields = [];
  const seen = new Set();
  let depth = 0;
  let i = 0;

  while (i < block.length) {
    const char = block[i];
    if (char === '#') {
      while (i < block.length && block[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (char === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0) {
      if (char === '.' && block.slice(i, i + 3) === '...') {
        i += 3;
        continue;
      }
      if (isNameStart(char)) {
        const start = i;
        i += 1;
        while (i < block.length && isNameChar(block[i])) {
          i += 1;
        }
        let name = block.slice(start, i);
        let j = i;
        while (j < block.length && /\s/.test(block[j])) {
          j += 1;
        }
        if (block[j] === ':') {
          j += 1;
          while (j < block.length && /\s/.test(block[j])) {
            j += 1;
          }
          if (j < block.length && isNameStart(block[j])) {
            const aliasStart = j;
            j += 1;
            while (j < block.length && isNameChar(block[j])) {
              j += 1;
            }
            name = block.slice(aliasStart, j);
            i = j;
          }
        }
        if (!seen.has(name) && !GRAPHQL_INTERNAL_FIELDS.has(name)) {
          seen.add(name);
          fields.push(name);
        }
        continue;
      }
    }
    i += 1;
  }

  return fields;
}

function isNameStart(char) {
  return /[A-Za-z_]/.test(char);
}

function isNameChar(char) {
  return /[A-Za-z0-9_]/.test(char);
}

function normalizeWebSocketEventName(value) {
  if (!value) {
    return '';
  }
  const normalized = String(value).trim();
  const lower = normalized.toLowerCase();
  if (lower === 'onopen') {
    return 'open';
  }
  if (lower === 'onclose') {
    return 'close';
  }
  if (lower === 'onmessage') {
    return 'message';
  }
  if (lower === 'onerror') {
    return 'error';
  }
  return normalized;
}

function extractWebSocketHandlers(content, file, results) {
  const patterns = [
    // Match: Socket.io event handlers
    // Examples: socket.on('message', handler)
    //           io.on('connection', (socket) => {...})
    //           socket.emit('event', data)
    /\b(?:socket|io|ws|connection)\s*\.\s*(?:on|once|emit)\s*\(\s*['"`]([^'"`]+)['"`]/gi,

    // Match: WebSocket addEventListener
    // Examples: ws.addEventListener('message', handler)
    //           websocket.addEventListener('open', callback)
    /\b(?:ws|websocket|socket)\s*\.\s*addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/gi,

    // Match: WebSocket onmessage/onopen/onclose style
    // Examples: ws.onmessage = (event) => {...}
    //           socket.onopen = function() {...}
    /\b(?:ws|websocket|socket)\s*\.\s*(onopen|onclose|onmessage|onerror)\s*=/gi,

    // Match: ws library patterns
    // Examples: wss.on('connection', ws => {...})
    //           WebSocket.Server({ port: 8080 })
    /\b(?:wss|WebSocketServer)\s*\.\s*on\s*\(\s*['"`]([^'"`]+)['"`]/gi,

    // Match: ActionCable (Rails)
    // Examples: App.cable.subscriptions.create('ChatChannel')
    //           received(data) { }
    /\bsubscriptions\.create\s*\(\s*['"`]([^'"`]+)['"`]/gi,

    // Match: Phoenix Channels (Elixir)
    // Examples: channel "room:*", RoomChannel
    //           socket.channel("room:lobby")
    /\bchannel\s*\(\s*['"`]([^'"`]+)['"`]/gi,

    // Match: SignalR
    // Examples: connection.on("ReceiveMessage", handler)
    //           hubConnection.invoke("SendMessage", message)
    /\b(?:connection|hubConnection)\s*\.\s*(?:on|invoke)\s*\(\s*['"`]([^'"`]+)['"`]/gi
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const eventName = normalizeWebSocketEventName(match[1]);
      if (eventName && !seen.has(eventName)) {
        seen.add(eventName);
        results.push(buildWebSocketEntity(eventName, file, content, match.index));
      }
    }
  }
}

function extractEventHandlers(content, file, results) {
  const ext = path.extname(file).toLowerCase();
  const patterns = [];

  if (ext === '.py') {
    patterns.push(
      // Django signals
      // Examples: @receiver(post_save, sender=User)
      //           post_save.connect(handler)
      /@receiver\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g,
      /\b([A-Za-z_][A-Za-z0-9_]*)\.connect\s*\(/g,

      // Celery tasks
      // Examples: @app.task
      //           @shared_task
      /@(?:app\.task|shared_task|celery\.task)/g,

      // FastAPI/Starlette events
      // Examples: @app.on_event("startup")
      //           @app.on_event("shutdown")
      /@\w+\.on_event\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    );
  } else if (ext === '.rb') {
    patterns.push(
      // ActiveRecord callbacks
      // Examples: before_save :normalize_name
      //           after_create :send_welcome_email
      /\b(before_|after_)(save|create|update|destroy|validation|commit|rollback)\s+:([A-Za-z_][A-Za-z0-9_]*)/g,

      // ActiveSupport::Notifications
      // Examples: ActiveSupport::Notifications.subscribe("process_action.action_controller")
      /Notifications\.subscribe\s*\(\s*['"]([^'"]+)['"]/g
    );
  } else {
    // JavaScript/TypeScript
    patterns.push(
      // DOM events
      // Examples: element.addEventListener('click', handler)
      //           document.addEventListener('DOMContentLoaded', init)
      /\.addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/gi,

      // Node.js EventEmitter
      // Examples: emitter.on('data', handler)
      //           process.on('uncaughtException', handler)
      //           server.on('error', handler)
      /\b(?:emitter|process|server|client|stream|worker)\s*\.\s*(?:on|once|addListener)\s*\(\s*['"`]([^'"`]+)['"`]/gi,

      // jQuery events (still used)
      // Examples: $(selector).on('click', handler)
      //           $('#btn').click(handler)
      /\$\([^)]+\)\s*\.\s*(?:on|click|submit|change|keyup|keydown|focus|blur|hover)\s*\(/g,

      // Vue events
      // Examples: @click="handler"
      //           v-on:submit="onSubmit"
      /@([A-Za-z:-]+)=["']/g,
      /v-on:([A-Za-z:-]+)=["']/g,

      // React synthetic events in JSX
      // Examples: onClick={handler}
      //           onSubmit={handleSubmit}
      /\b(on[A-Z][A-Za-z]+)\s*=\s*\{/g
    );
  }

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const eventName = match[1] || match[2] || match[3];
      if (eventName && !seen.has(eventName)) {
        // Filter out common non-events
        if (['function', 'return', 'const', 'let', 'var'].includes(eventName)) {
          continue;
        }
        seen.add(eventName);
        results.push(buildEntity('event', `Event: ${eventName}`, '', file, content, match.index));
      }
    }
  }
}

function extractComponents(content, file, results) {
  const ext = path.extname(file).toLowerCase();
  if (!['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'].includes(ext)) {
    return;
  }

  const patterns = [
    // Match: React functional components
    // Examples: function UserProfile({ name, avatar }) {...}
    //           const UserCard = ({ user }) => {...}
    //           export default function Dashboard() {...}
    /\b(?:export\s+(?:default\s+)?)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)\s*(?::\s*(?:React\.)?FC[^=]*)?[=\s]*(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*(?:=>|{)/g,

    // Match: React.memo, React.forwardRef wrapped components
    // Examples: const MemoComponent = React.memo(({ prop }) => {...})
    //           export const ForwardedInput = React.forwardRef((props, ref) => {...})
    /\b(?:export\s+)?(?:const|let)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:React\.)?(?:memo|forwardRef|lazy)\s*\(/g,

    // Match: Vue component definition
    // Examples: export default defineComponent({ name: 'UserProfile' })
    //           export default { name: 'UserCard', ... }
    /(?:defineComponent|createComponent)\s*\(\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/g,

    // Match: Vue <script setup> or composition API
    // Examples: <script setup> in .vue files
    //           const emit = defineEmits(['update'])
    //           const props = defineProps<{ name: string }>()
    /\bdefine(?:Props|Emits|Expose|Slots)\s*(?:<[^>]+>)?\s*\(\s*(?:\{|\[)?/g,

    // Match: Svelte component exports
    // Examples: export let name;
    //           export let user = { name: 'default' };
    /^\s*export\s+let\s+([A-Za-z_][A-Za-z0-9_]*)/gm,

    // Match: Angular component decorator
    // Examples: @Component({ selector: 'app-user' })
    /@Component\s*\(\s*\{[^}]*selector\s*:\s*['"]([^'"]+)['"]/g,

    // Match: Stencil component decorator
    // Examples: @Component({ tag: 'my-button' })
    /@Component\s*\(\s*\{[^}]*tag\s*:\s*['"]([^'"]+)['"]/g,

    // Match: Custom Elements
    // Examples: customElements.define('my-element', MyElement)
    /customElements\.define\s*\(\s*['"]([^'"]+)['"]/g
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const componentName = match[1];
      if (componentName && !seen.has(componentName)) {
        seen.add(componentName);
        results.push(buildEntity('component', `Component: ${componentName}`, '', file, content, match.index));
      }
    }
  }
}

function extractDatabaseModels(content, file, results) {
  const ext = path.extname(file).toLowerCase();
  const patterns = [];

  if (ext === '.py') {
    patterns.push(
      // Django models
      // Examples: class User(models.Model):
      //           class Product(AbstractModel):
      /\bclass\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*(?:models\.Model|AbstractUser|AbstractBaseUser)/g,

      // SQLAlchemy models
      // Examples: class User(Base):
      //           class Product(db.Model):
      /\bclass\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*(?:Base|db\.Model|DeclarativeBase)/g,

      // Pydantic models (for API schemas)
      // Examples: class UserCreate(BaseModel):
      //           class ProductResponse(BaseModel):
      /\bclass\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*(?:BaseModel|BaseSettings)/g,

      // Django model fields
      // Examples: name = models.CharField(max_length=100)
      //           email = models.EmailField(unique=True)
      /^\s*([a-z_][a-z0-9_]*)\s*=\s*models\.[A-Z][A-Za-z]+Field/gm
    );
  } else if (ext === '.rb') {
    patterns.push(
      // ActiveRecord models
      // Examples: class User < ApplicationRecord
      //           class Product < ActiveRecord::Base
      /\bclass\s+([A-Z][A-Za-z0-9_]*)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/g,

      // Rails associations
      // Examples: has_many :posts
      //           belongs_to :user
      //           has_one :profile
      /\b(has_many|has_one|belongs_to|has_and_belongs_to_many)\s+:([A-Za-z_][A-Za-z0-9_]*)/g
    );
  } else if (ext === '.go') {
    patterns.push(
      // GORM models
      // Examples: type User struct { gorm.Model }
      /\btype\s+([A-Z][A-Za-z0-9_]*)\s+struct\s*\{[^}]*gorm\.Model/g,

      // Struct with json/db tags
      // Examples: Name string `json:"name" db:"name"`
      /^\s*([A-Z][A-Za-z0-9_]*)\s+[A-Za-z[\]]+\s+`[^`]*(?:json|db|gorm):/gm
    );
  } else {
    // JavaScript/TypeScript
    patterns.push(
      // Prisma models
      // Examples: model User { ... }
      //           model Product { ... }
      /\bmodel\s+([A-Z][A-Za-z0-9_]*)\s*\{/g,

      // TypeORM entities - capture class name following @Entity decorator
      // Examples: @Entity() export class User { ... }
      //           @Entity('orders') export class Order { ... }
      /@Entity\s*\([^)]*\)\s*(?:export\s+)?class\s+([A-Z][A-Za-z0-9_]*)/g,

      // Mongoose schemas
      // Examples: const UserSchema = new Schema({...})
      //           const userSchema = new mongoose.Schema({...})
      /\b([A-Z]?[a-z]+)Schema\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(/g,

      // Sequelize models
      // Examples: User.init({...}, { sequelize })
      //           sequelize.define('User', {...})
      /\b([A-Z][A-Za-z0-9_]*)\.init\s*\(\s*\{/g,
      /sequelize\.define\s*\(\s*['"]([^'"]+)['"]/g,

      // Drizzle ORM
      // Examples: export const users = pgTable('users', {...})
      /\b(?:export\s+)?(?:const|let)\s+([a-z][A-Za-z0-9_]*)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g,

      // Knex migrations
      // Examples: table.string('name')
      //           table.integer('age')
      /\btable\.(string|integer|boolean|text|json|timestamp|date|float|decimal|bigInteger|uuid)\s*\(\s*['"]([^'"]+)['"]/g
    );
  }

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const modelName = match[1] || match[2];
      if (modelName && !seen.has(modelName)) {
        seen.add(modelName);
        results.push(buildEntity('model', `Model: ${modelName}`, '', file, content, match.index));
      }
    }
  }
}

function extractTestDescriptions(content, file, results) {
  // Only process test files
  const filename = path.basename(file).toLowerCase();
  const isTestFile = filename.includes('test') || filename.includes('spec') ||
                     file.includes('__tests__') || file.includes('/tests/') ||
                     file.includes('/test/') || file.includes('/spec/');
  if (!isTestFile) {
    return;
  }

  const patterns = [
    // Match: Jest/Mocha/Vitest describe blocks
    // Examples: describe('UserService', () => {...})
    //           describe("authentication", function() {...})
    /\b(?:describe|context|suite)\s*\(\s*['"`]([^'"`]+)['"`]/g,

    // Match: Jest/Mocha/Vitest test cases
    // Examples: it('should create user', () => {...})
    //           test("handles errors", async () => {...})
    //           specify('works correctly', () => {...})
    /\b(?:it|test|specify)\s*\(\s*['"`]([^'"`]+)['"`]/g,

    // Match: Jest/Vitest test.each
    // Examples: test.each([...])('should handle %s', ...)
    //           it.each(cases)('processes %s correctly', ...)
    /\b(?:test|it)\.each\s*\([^)]*\)\s*\(\s*['"`]([^'"`]+)['"`]/g,

    // Match: Python pytest
    // Examples: def test_user_creation():
    //           async def test_async_operation():
    /\b(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/g,

    // Match: Python unittest
    // Examples: class TestUserService(unittest.TestCase):
    /\bclass\s+(Test[A-Z][A-Za-z0-9_]*)\s*\(/g,

    // Match: Go tests
    // Examples: func TestUserCreation(t *testing.T)
    //           func TestMain(m *testing.M)
    /\bfunc\s+(Test[A-Z][A-Za-z0-9_]*)\s*\([^)]*\*testing\./g,

    // Match: Ruby RSpec
    // Examples: RSpec.describe UserService do
    //           context 'when user exists' do
    /\bRSpec\.describe\s+([A-Z][A-Za-z0-9_:]*)/g,

    // Match: Java JUnit
    // Examples: @Test public void shouldCreateUser()
    //           @Test void testUserCreation()
    /@Test[^{]*\bvoid\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,

    // Match: C# xUnit/NUnit
    // Examples: [Fact] public void Should_Create_User()
    //           [Test] public async Task TestAsyncOperation()
    /\[(?:Fact|Test|Theory)\][^{]*\b(?:void|Task)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const testName = match[1];
      if (testName && !seen.has(testName)) {
        seen.add(testName);
        results.push(buildEntity('test', `Test: ${testName}`, '', file, content, match.index));
      }
    }
  }
}

function extractCliCommands(content, file, results) {
  const ext = path.extname(file).toLowerCase();
  const patterns = [];

  if (ext === '.py') {
    patterns.push(
      // Click commands
      // Examples: @click.command()
      //           @cli.command()
      //           @app.command('deploy')
      /@(?:click|cli|app)\.command\s*\(\s*(?:['"]([^'"]+)['"])?\s*\)/g,

      // Click options/arguments
      // Examples: @click.option('--name', '-n', help='User name')
      //           @click.argument('filename')
      /@click\.(?:option|argument)\s*\(\s*['"]([^'"]+)['"]/g,

      // Typer commands
      // Examples: @app.command()
      //           def main(name: str = typer.Option(...)):
      /typer\.(?:Option|Argument)\s*\([^)]*help\s*=\s*['"]([^'"]+)['"]/g,

      // argparse
      // Examples: parser.add_argument('--verbose', '-v')
      //           subparsers.add_parser('deploy')
      /\.add_argument\s*\(\s*['"](-{1,2}[A-Za-z0-9_-]+)['"]/g,
      /\.add_parser\s*\(\s*['"]([A-Za-z0-9_-]+)['"]/g
    );
  } else if (ext === '.go') {
    patterns.push(
      // Cobra commands
      // Examples: &cobra.Command{ Use: "deploy" }
      //           rootCmd.AddCommand(deployCmd)
      /&cobra\.Command\s*\{\s*Use:\s*['"]([^'"]+)['"]/g,

      // Flag definitions
      // Examples: cmd.Flags().StringP("name", "n", "", "description")
      //           rootCmd.PersistentFlags().Bool("verbose", false, "")
      /\.(?:Flags|PersistentFlags)\(\)\.(?:String|Bool|Int|Float)[P]?\s*\(\s*['"]([^'"]+)['"]/g
    );
  } else {
    // JavaScript/TypeScript
    patterns.push(
      // Commander.js
      // Examples: program.command('deploy <app>')
      //           program.option('-v, --verbose')
      //           program.argument('<name>')
      /\.command\s*\(\s*['"`]([^'"`]+)['"`]/g,
      /\.option\s*\(\s*['"`]([^'"`]+)['"`]/g,
      /\.argument\s*\(\s*['"`]([^'"`]+)['"`]/g,

      // Yargs
      // Examples: yargs.command('deploy', 'Deploy the app')
      //           .option('verbose', { alias: 'v' })
      /yargs\s*\.command\s*\(\s*['"`]([^'"`]+)['"`]/g,
      /\.option\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g,

      // Meow, CAC, Clipanion etc.
      // Examples: meow({ flags: { verbose: { type: 'boolean' }}})
      //           cac().command('build', 'Build the project')
      /\.command\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g
    );
  }

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const cmdName = match[1];
      if (cmdName && !seen.has(cmdName)) {
        // Filter out placeholder patterns
        if (cmdName.startsWith('<') || cmdName.startsWith('[')) {
          continue;
        }
        seen.add(cmdName);
        results.push(buildEntity('cli', `CLI: ${cmdName}`, '', file, content, match.index));
      }
    }
  }
}

module.exports = {
  detectDocsDrift
};
