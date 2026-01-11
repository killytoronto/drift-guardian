'use strict';

/**
 * Performance benchmarks for Drift Guardian.
 * Run with: node test/benchmark.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectDocsDrift } = require('../src/detectors/docsDrift');

// Benchmark configuration
const BENCHMARK_CONFIG = {
  smallFile: { lines: 100, functions: 10 },
  mediumFile: { lines: 1000, functions: 100 },
  largeFile: { lines: 10000, functions: 500 },
  iterations: 3
};

/**
 * Generates a mock JavaScript file with the specified number of functions.
 * @param {number} numFunctions - Number of functions to generate
 * @param {number} linesPerFunction - Lines per function
 * @returns {string}
 */
function generateMockJsFile(numFunctions, linesPerFunction = 5) {
  const lines = ["'use strict';", ''];
  for (let i = 0; i < numFunctions; i++) {
    lines.push(`export function generatedFunc${i}(param1, param2, param3) {`);
    for (let j = 0; j < linesPerFunction - 2; j++) {
      lines.push(`  const value${j} = param1 + param2 + ${j};`);
    }
    lines.push('}', '');
  }
  return lines.join('\n');
}

/**
 * Generates a mock Python file with the specified number of functions.
 * @param {number} numFunctions - Number of functions to generate
 * @returns {string}
 */
function generateMockPyFile(numFunctions) {
  const lines = ['# Generated Python file', ''];
  for (let i = 0; i < numFunctions; i++) {
    lines.push(`def generated_func_${i}(param1, param2, param3):`);
    lines.push('    """Docstring for generated function."""');
    lines.push(`    return param1 + param2 + ${i}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Generates a mock API file with endpoints.
 * @param {number} numEndpoints - Number of endpoints to generate
 * @returns {string}
 */
function generateMockApiFile(numEndpoints) {
  const methods = ['get', 'post', 'put', 'delete', 'patch'];
  const lines = ["'use strict';", "const express = require('express');", 'const app = express();', ''];
  for (let i = 0; i < numEndpoints; i++) {
    const method = methods[i % methods.length];
    lines.push(`app.${method}('/api/v1/resource${i}/:id', (req, res) => {`);
    lines.push('  res.json({ success: true });');
    lines.push('});', '');
  }
  return lines.join('\n');
}

/**
 * Creates a temporary directory with mock files.
 * @param {Object} config - Configuration for file generation
 * @returns {string} Path to temp directory
 */
function createBenchmarkDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-benchmark-'));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // Generate JS files
  fs.writeFileSync(
    path.join(srcDir, 'functions.js'),
    generateMockJsFile(config.functions)
  );

  // Generate Python files
  fs.writeFileSync(
    path.join(srcDir, 'functions.py'),
    generateMockPyFile(config.functions)
  );

  // Generate API file
  fs.writeFileSync(
    path.join(srcDir, 'api.js'),
    generateMockApiFile(Math.floor(config.functions / 2))
  );

  // Generate empty README
  fs.writeFileSync(path.join(dir, 'README.md'), '# Benchmark Project\n');

  return dir;
}

/**
 * Cleans up benchmark directory.
 * @param {string} dir - Directory to clean up
 */
function cleanupBenchmarkDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Measures execution time and memory for a function.
 * @param {Function} fn - Async function to measure
 * @returns {Promise<{duration: number, memoryUsed: number}>}
 */
async function measure(fn) {
  const startMemory = process.memoryUsage().heapUsed;
  const startTime = process.hrtime.bigint();

  await fn();

  const endTime = process.hrtime.bigint();
  const endMemory = process.memoryUsage().heapUsed;

  return {
    duration: Number(endTime - startTime) / 1_000_000, // ms
    memoryUsed: (endMemory - startMemory) / 1024 / 1024 // MB
  };
}

/**
 * Runs a single benchmark scenario.
 * @param {string} name - Scenario name
 * @param {Object} config - Configuration
 * @param {number} iterations - Number of iterations
 * @returns {Promise<Object>}
 */
async function runBenchmark(name, config, iterations) {
  const results = [];
  const dir = createBenchmarkDir(config);

  try {
    const benchConfig = {
      docsDrift: {
        enabled: true,
        codeFiles: ['src/**/*.js', 'src/**/*.py'],
        docFiles: ['README.md'],
        extract: ['function-signatures', 'api-endpoints', 'env-variables'],
        fullScan: false,
        fullScanMaxFiles: 200,
        payloadKeysAllowlist: [],
        maxDocChars: 20000,
        maxEntities: 500
      },
      logicDrift: { enabled: false, rules: [] },
      output: {
        format: 'json',
        severity: { docsDrift: 'warning', logicDrift: 'error' },
        failOnError: false
      }
    };

    // Warm-up run
    await detectDocsDrift({
      repoRoot: dir,
      changedFiles: [
        { path: 'src/functions.js' },
        { path: 'src/functions.py' },
        { path: 'src/api.js' }
      ],
      config: benchConfig
    });

    // Measured runs
    for (let i = 0; i < iterations; i++) {
      const result = await measure(async () => {
        await detectDocsDrift({
          repoRoot: dir,
          changedFiles: [
            { path: 'src/functions.js' },
            { path: 'src/functions.py' },
            { path: 'src/api.js' }
          ],
          config: benchConfig
        });
      });
      results.push(result);
    }
  } finally {
    cleanupBenchmarkDir(dir);
  }

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
  const avgMemory = results.reduce((sum, r) => sum + r.memoryUsed, 0) / results.length;
  const minDuration = Math.min(...results.map(r => r.duration));
  const maxDuration = Math.max(...results.map(r => r.duration));

  return {
    name,
    config,
    iterations,
    avgDuration: avgDuration.toFixed(2),
    minDuration: minDuration.toFixed(2),
    maxDuration: maxDuration.toFixed(2),
    avgMemory: avgMemory.toFixed(2),
    throughput: ((config.functions * 3) / (avgDuration / 1000)).toFixed(0) // entities/second
  };
}

/**
 * Main benchmark runner.
 */
async function main() {
  console.log('Drift Guardian Performance Benchmarks');
  console.log('=====================================');
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${os.platform()} ${os.arch()}`);
  console.log(`CPUs: ${os.cpus().length}`);
  console.log(`Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`);
  console.log('');

  const benchmarks = [
    { name: 'Small codebase', config: BENCHMARK_CONFIG.smallFile },
    { name: 'Medium codebase', config: BENCHMARK_CONFIG.mediumFile },
    { name: 'Large codebase', config: BENCHMARK_CONFIG.largeFile }
  ];

  const results = [];
  for (const benchmark of benchmarks) {
    console.log(`Running: ${benchmark.name} (${benchmark.config.functions} functions)...`);
    const result = await runBenchmark(
      benchmark.name,
      benchmark.config,
      BENCHMARK_CONFIG.iterations
    );
    results.push(result);
    console.log(`  Avg: ${result.avgDuration}ms (min: ${result.minDuration}ms, max: ${result.maxDuration}ms)`);
    console.log(`  Memory: ${result.avgMemory}MB, Throughput: ${result.throughput} entities/sec`);
    console.log('');
  }

  console.log('Summary');
  console.log('-------');
  console.log('| Scenario | Functions | Avg Time | Throughput |');
  console.log('|----------|-----------|----------|------------|');
  for (const r of results) {
    console.log(`| ${r.name.padEnd(8)} | ${String(r.config.functions).padEnd(9)} | ${r.avgDuration.padStart(6)}ms | ${r.throughput.padStart(6)}/s |`);
  }

  // Return results for programmatic use
  return results;
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main, runBenchmark, generateMockJsFile };
