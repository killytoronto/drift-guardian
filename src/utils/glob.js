'use strict';

const cache = new Map();

function matchAny(filePath, patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const normalized = normalizePath(filePath);
  return patterns.some((pattern) => match(normalized, pattern));
}

function match(filePath, pattern) {
  const regex = cache.get(pattern) || globToRegExp(pattern);
  if (!cache.has(pattern)) {
    cache.set(pattern, regex);
  }
  return regex.test(filePath);
}

function globToRegExp(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*\\/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (char === '?') {
      re += '.';
      i += 1;
      continue;
    }
    if (char === '.') {
      re += '\\.';
      i += 1;
      continue;
    }
    if (char === '/') {
      re += '\\/';
      i += 1;
      continue;
    }
    re += escapeRegExp(char);
    i += 1;
  }
  re += '$';
  return new RegExp(re);
}

function escapeRegExp(char) {
  return char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

module.exports = {
  matchAny
};
