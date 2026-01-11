'use strict';

/**
 * @typedef {import('./types').Config} Config
 * @typedef {import('./types').DriftResult} DriftResult
 * @typedef {import('./types').LLMClient} LLMClient
 */

const { loadConfig } = require('./config');
const { getContext, getChangedFiles } = require('./git');
const { createLLMClient } = require('./llm/client');
const { detectDocsDrift } = require('./detectors/docsDrift');
const { detectLogicDrift } = require('./detectors/logicDrift');
const { postComment, formatResultsMarkdown } = require('./reporters/github');

/**
 * Main entry point for the Drift Guardian GitHub Action.
 * Detects drift between code, documentation, and business policies.
 * @returns {Promise<void>}
 */
async function main() {
  const repoRoot = process.cwd();
  const configPath = process.env.INPUT_CONFIG || '.drift.config.yml';
  const llmApiKey = process.env.INPUT_LLM_API_KEY || '';
  const inputFailOnError = process.env.INPUT_FAIL_ON_ERROR;

  const config = loadConfig(configPath, {
    repoRoot,
    llmApiKey,
    failOnErrorInput: inputFailOnError
  });

  const context = getContext();
  const changedFiles = getChangedFiles(context.baseSha, context.headSha);
  const llm = config.llm && config.llm.enabled ? createLLMClient(config.llm) : null;

  const results = [];

  if (config.docsDrift.enabled) {
    const docsResults = await detectDocsDrift({
      repoRoot,
      changedFiles,
      config,
      llm,
      baseSha: context.baseSha,
      headSha: context.headSha
    });
    results.push(...docsResults);
  }

  if (config.logicDrift.enabled) {
    const logicResults = await detectLogicDrift({
      repoRoot,
      changedFiles,
      config,
      llm,
      baseSha: context.baseSha,
      headSha: context.headSha
    });
    results.push(...logicResults);
  }

  if (results.length === 0) {
    console.log('Drift Guardian: no drift detected.');
  } else {
    console.log(`Drift Guardian: ${results.length} possible drift(s) detected.`);
  }

  if (config.output.format === 'github-comment' && context.prNumber) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.warn('GITHUB_TOKEN not set; cannot post PR comment.');
    } else {
      const body = formatResultsMarkdown(results, config);
      await postComment({
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        token,
        body
      });
    }
  } else if (!context.prNumber) {
    console.log('Drift Guardian: no pull request context, skipping PR comment.');
  }

  if (shouldFail(results, config)) {
    console.error('Drift Guardian: failing the check due to error-level drift.');
    process.exitCode = 1; // eslint-disable-line require-atomic-updates
  }
}

/**
 * Determines if the check should fail based on results and configuration.
 * @param {DriftResult[]} results - Array of drift detection results
 * @param {Config} config - Configuration object
 * @returns {boolean} True if the check should fail
 */
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

main().catch((err) => {
  console.error(`Drift Guardian failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
