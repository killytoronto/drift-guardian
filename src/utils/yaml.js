'use strict';

function parseYaml(input) {
  const root = {};
  const stack = [{ indent: -1, type: 'object', value: root, pendingKey: null, pendingIndent: null }];
  const lines = input.split(/\r?\n/);

  for (const rawLine of lines) {
    const lineWithoutComments = stripComments(rawLine);
    if (!lineWithoutComments.trim()) {
      continue;
    }

    const indent = countIndent(lineWithoutComments);
    const line = lineWithoutComments.trim();

    while (stack.length > 1 && indent <= current().indent) {
      stack.pop();
    }

    let ctx = current();
    if (ctx.type === 'object' && ctx.pendingKey) {
      if (indent > ctx.pendingIndent) {
        const container = line.startsWith('- ') ? [] : {};
        const containerIndent = ctx.pendingIndent;
        ctx.value[ctx.pendingKey] = container;
        ctx.pendingKey = null;
        ctx.pendingIndent = null;
        stack.push({
          indent: containerIndent,
          type: Array.isArray(container) ? 'array' : 'object',
          value: container,
          pendingKey: null,
          pendingIndent: null
        });
        ctx = current();
      } else {
        ctx.pendingKey = null;
        ctx.pendingIndent = null;
      }
    }

    if (line.startsWith('- ')) {
      if (ctx.type !== 'array') {
        throw new Error('Invalid YAML structure: list item without array');
      }
      const itemStr = line.slice(2).trim();
      if (!itemStr) {
        const obj = {};
        ctx.value.push(obj);
        stack.push({ indent, type: 'object', value: obj, pendingKey: null, pendingIndent: null });
        continue;
      }

      if (itemStr.includes(':')) {
        const parsed = parseKeyValue(itemStr);
        const obj = {};
        ctx.value.push(obj);
        if (parsed.hasValue) {
          obj[parsed.key] = parseScalar(parsed.value);
          stack.push({ indent, type: 'object', value: obj, pendingKey: null, pendingIndent: null });
        } else {
          obj[parsed.key] = null;
          stack.push({ indent, type: 'object', value: obj, pendingKey: parsed.key, pendingIndent: indent });
        }
        continue;
      }

      ctx.value.push(parseScalar(itemStr));
      continue;
    }

    const parsed = parseKeyValue(line);
    if (!parsed.hasValue) {
      ctx.value[parsed.key] = null;
      ctx.pendingKey = parsed.key;
      ctx.pendingIndent = indent;
    } else {
      ctx.value[parsed.key] = parseScalar(parsed.value);
      ctx.pendingKey = null;
      ctx.pendingIndent = null;
    }
  }

  return root;

  function current() {
    return stack[stack.length - 1];
  }
}

function parseKeyValue(line) {
  const index = line.indexOf(':');
  if (index === -1) {
    throw new Error(`Invalid YAML line: ${line}`);
  }
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim();
  return {
    key,
    value,
    hasValue: value !== ''
  };
}

function parseScalar(value) {
  if (!value) {
    return '';
  }
  if (value === 'null' || value === '~') {
    return null;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const numberValue = Number(value);
  if (!Number.isNaN(numberValue) && value.match(/^[-+]?[0-9]*\.?[0-9]+$/)) {
    return numberValue;
  }
  return value;
}

function countIndent(line) {
  let count = 0;
  for (const char of line) {
    if (char === ' ') {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function stripComments(line) {
  let inSingle = false;
  let inDouble = false;
  let result = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      result += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      result += char;
      continue;
    }
    if (char === '#' && !inSingle && !inDouble) {
      break;
    }
    result += char;
  }
  return result;
}

module.exports = {
  parseYaml
};
