'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

function getContext() {
  const repoFull = process.env.GITHUB_REPOSITORY || '';
  const repoParts = repoFull.split('/');
  const owner = repoParts[0] || '';
  const repo = repoParts[1] || '';

  let prNumber = null;
  let baseSha = null;
  let headSha = null;

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    if (event.pull_request) {
      prNumber = event.pull_request.number;
      baseSha = event.pull_request.base && event.pull_request.base.sha;
      headSha = event.pull_request.head && event.pull_request.head.sha;
    }
  }

  if (!headSha) {
    headSha = process.env.GITHUB_SHA || runGit(['rev-parse', 'HEAD']);
  }

  if (!baseSha) {
    baseSha = process.env.GITHUB_BASE_SHA;
    if (!baseSha) {
      try {
        baseSha = runGit(['rev-parse', 'HEAD~1']);
      } catch (err) {
        baseSha = headSha;
      }
    }
  }

  return {
    owner,
    repo,
    prNumber,
    baseSha,
    headSha
  };
}

function getChangedFiles(baseSha, headSha) {
  const output = runGit(['diff', '--name-status', `${baseSha}...${headSha}`]);
  if (!output.trim()) {
    return [];
  }
  return output.split('\n').map((line) => {
    const parts = line.split('\t');
    return {
      status: parts[0],
      path: parts[parts.length - 1]
    };
  }).filter((entry) => entry.path);
}

function getFileDiff(baseSha, headSha, file) {
  return runGit(['diff', `${baseSha}...${headSha}`, '--', file]);
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
}

module.exports = {
  getContext,
  getChangedFiles,
  getFileDiff
};
