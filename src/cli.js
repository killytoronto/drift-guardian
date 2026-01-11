#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { getContext, getChangedFiles } = require('./git');
const { createLLMClient } = require('./llm/client');
const { detectDocsDrift } = require('./detectors/docsDrift');
const { detectLogicDrift } = require('./detectors/logicDrift');
const { formatResultsMarkdown } = require('./reporters/github');

function parseArgs(argv) {
  const args = {
    config: '.drift.config.yml',
    base: null,
    head: null,
    format: null,
    failOnError: undefined,
    llmApiKey: undefined,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--config') {
      args.config = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      args.config = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg === '--base') {
      args.base = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--base=')) {
      args.base = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg === '--head') {
      args.head = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--head=')) {
      args.head = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg === '--format') {
      args.format = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--format=')) {
      args.format = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg === '--fail-on-error') {
      args.failOnError = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--fail-on-error=')) {
      args.failOnError = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg === '--llm-api-key') {
      args.llmApiKey = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--llm-api-key=')) {
      args.llmApiKey = arg.split('=').slice(1).join('=');
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  const text = `Usage: drift-guardian [options]

Options:
  --config <path>        Path to config file (default: .drift.config.yml)
  --base <sha>           Base git ref/sha for diff (default: HEAD~1)
  --head <sha>           Head git ref/sha for diff (default: HEAD)
  --format <format>      Output format: text, markdown, json
  --fail-on-error <bool> Override output.fail_on_error from config
  --llm-api-key <key>    API key for LLM provider (optional)
  -h, --help             Show help
`;
  console.log(text);
}

function normalizeFormat(value) {
  if (!value) {
    return 'text';
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'github-comment') {
    return 'markdown';
  }
  return normalized;
}

function formatResultsText(results) {
  if (!results || results.length === 0) {
    return 'Drift Guardian: no drift detected.';
  }
  return results.map((item) => {
    const parts = [];
    parts.push(item.severity ? item.severity.toUpperCase() : 'INFO');
    if (item.source) {
      parts.push(item.source);
    }
    if (item.type) {
      parts.push(item.type);
    }
    if (item.rule) {
      parts.push(`rule=${item.rule}`);
    }
    if (item.file) {
      parts.push(`file=${item.file}`);
    }
    if (item.explanation) {
      parts.push(item.explanation);
    }
    return parts.join(' | ');
  }).join('\n');
}

function shouldFail(results, config) {
  if (!config.output.failOnError) {
    return false;
  }
  const allowNonDeterministic = config.output.allowNonDeterministicFail;
  return results.some((r) => {
    const isDeterministic = r.deterministic !== false;
    if (!isDeterministic && !allowNonDeterministic) {
      return false;
    }
    return r.severity === 'error' || r.severity === 'critical';
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = process.cwd();
  const config = loadConfig(args.config, {
    repoRoot,
    llmApiKey: args.llmApiKey,
    failOnErrorInput: args.failOnError
  });

  const context = getContext();
  const baseSha = args.base || context.baseSha;
  const headSha = args.head || context.headSha;
  const changedFiles = getChangedFiles(baseSha, headSha);
  const llm = config.llm && config.llm.enabled ? createLLMClient(config.llm) : null;

  const results = [];

  if (config.docsDrift.enabled) {
    results.push(...await detectDocsDrift({
      repoRoot,
      changedFiles,
      config,
      llm,
      baseSha,
      headSha
    }));
  }

  if (config.logicDrift.enabled) {
    results.push(...await detectLogicDrift({
      repoRoot,
      changedFiles,
      config,
      llm,
      baseSha,
      headSha
    }));
  }

  const format = normalizeFormat(args.format || config.output.format);
  if (format === 'json') {
    console.log(JSON.stringify({ results }, null, 2));
  } else if (format === 'markdown') {
    console.log(formatResultsMarkdown(results, config));
  } else {
    console.log(formatResultsText(results));
  }

  if (shouldFail(results, config)) {
    process.exitCode = 1; // eslint-disable-line require-atomic-updates
  }
}

main().catch((err) => {
  console.error(`Drift Guardian CLI failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
