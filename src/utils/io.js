'use strict';

const fs = require('fs');
const path = require('path');
const { matchAny } = require('./glob');

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist']);

function findFiles(rootDir, patterns) {
  const files = listFiles(rootDir, rootDir, []);
  return files.filter((file) => matchAny(file, patterns));
}

function listFiles(currentDir, rootDir, results) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      listFiles(path.join(currentDir, entry.name), rootDir, results);
    } else if (entry.isFile()) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      results.push(relPath);
    }
  }
  return results;
}

module.exports = {
  findFiles
};
