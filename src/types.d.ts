/**
 * Type definitions for Drift Guardian
 */

/** Drift detection result */
export interface DriftResult {
  source: 'docs-drift' | 'docs-drift-llm' | 'logic-drift' | 'logic-drift-llm';
  type: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  deterministic: boolean;
  file?: string;
  rule?: string;
  explanation: string;
  suggestion?: string;
  policySection?: string;
}

/** Changed file from git */
export interface ChangedFile {
  path: string;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
}

/** Code entity extracted from source files */
export interface CodeEntity {
  type: 'function' | 'endpoint' | 'env' | 'class' | 'config-key' | 'cli-flag' | 'cli' | 'component' | 'model' | 'event' | 'test' | 'graphql-operation' | 'ws-event';
  name: string;
  signature: string;
  file: string;
  line: number;
  opType?: string;
}

/** Document entry for comparison */
export interface DocEntry {
  file: string;
  content: string;
}

/** Configuration for docs drift detection */
export interface DocsDriftConfig {
  enabled: boolean;
  codeFiles: string[];
  docFiles: string[];
  extract: string[];
  fullScan: boolean | 'auto';
  fullScanMaxFiles: number;
  payloadKeysAllowlist: string[];
  maxDocChars: number;
  maxEntities: number;
  rules?: DocsDriftRule[];
}

/** Rule for docs drift detection */
export interface DocsDriftRule {
  name?: string;
  codeFiles: string[];
  docFiles: string[];
  extract: string[];
  fullScan?: boolean | 'auto';
  fullScanMaxFiles?: number;
  payloadKeysAllowlist?: string[];
  maxDocChars?: number;
  maxEntities?: number;
}

/** Configuration for logic drift detection */
export interface LogicDriftConfig {
  enabled: boolean;
  rules: LogicDriftRule[];
  maxDiffChars?: number;
  maxPolicyChars?: number;
}

/** Rule for logic drift detection */
export interface LogicDriftRule {
  name: string;
  codeFiles: string[];
  policyFiles: string[];
  comparisons?: Comparison[];
}

/** Deterministic comparison rule */
export interface Comparison {
  name?: string;
  code_pattern: string;
  policy_pattern: string;
  code_flags?: string;
  policy_flags?: string;
  compare?: 'equals' | 'not_equals' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
  value_type?: 'auto' | 'string' | 'number';
  severity?: string;
}

/** LLM configuration */
export interface LLMConfig {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  mockResponse?: string;
}

/** Output configuration */
export interface OutputConfig {
  format: 'github-comment' | 'json' | 'text';
  severity: {
    docsDrift: string;
    logicDrift: string;
  };
  failOnError: boolean;
  allowNonDeterministicFail?: boolean;
}

/** Main configuration object */
export interface Config {
  docsDrift: DocsDriftConfig;
  logicDrift: LogicDriftConfig;
  llm?: LLMConfig;
  output: OutputConfig;
}

/** LLM client interface */
export interface LLMClient {
  complete(prompt: string): Promise<string>;
}

/** Function type for getting file diffs */
export type GetFileDiffFn = (baseSha: string, headSha: string, file: string) => string;

/** Parameters for detectDocsDrift */
export interface DetectDocsDriftParams {
  repoRoot: string;
  changedFiles: ChangedFile[];
  config: Config;
  llm?: LLMClient | null;
  baseSha?: string;
  headSha?: string;
  getFileDiff?: GetFileDiffFn;
}

/** Parameters for detectLogicDrift */
export interface DetectLogicDriftParams {
  repoRoot: string;
  changedFiles: ChangedFile[];
  config: Config;
  llm?: LLMClient | null;
  baseSha: string;
  headSha: string;
  getFileDiff?: GetFileDiffFn;
}

/** Cache entry */
export interface CacheEntry {
  hash: string;
  timestamp: number;
  data: unknown;
}
