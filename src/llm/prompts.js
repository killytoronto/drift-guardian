'use strict';

function buildDocsDriftPrompt(entities, docs) {
  return [
    'You are a strict documentation drift detector.',
    'Only flag drift when you are confident there is a mismatch.',
    'If there is no drift, return: {"drifts": []}',
    'Return ONLY valid JSON and no extra commentary.',
    '',
    'CHANGED CODE ENTITIES:',
    JSON.stringify(entities, null, 2),
    '',
    'DOCUMENTATION:',
    docs,
    '',
    'Respond with JSON in this shape:',
    '{"drifts": [{"type": "function-signature-mismatch", "severity": "warning", "code_entity": "createUser(email, password)", "doc_claim": "createUser(username, password)", "file": "src/users.ts", "explanation": "Docs mention username, code uses email.", "suggestion": "Update docs to use email"}]}'
  ].join('\n');
}

function buildLogicDriftPrompt(params) {
  return [
    'You are a business logic policy validator.',
    'Only flag contradictions that are clearly supported by the code diff and policy text.',
    'If there is no contradiction, return: {"contradicts_policy": false}',
    'Return ONLY valid JSON and no extra commentary.',
    '',
    `RULE: ${params.ruleName}`,
    '',
    'CODE CHANGES:',
    params.codeDiff,
    '',
    'BUSINESS POLICY:',
    params.policyText,
    '',
    'Respond with JSON in this shape:',
    '{"contradicts_policy": true, "severity": "critical", "explanation": "Refund window changed to 7 days but policy says 30.", "affected_policy_section": "Refunds", "suggestion": "Align code or policy"}'
  ].join('\n');
}

module.exports = {
  buildDocsDriftPrompt,
  buildLogicDriftPrompt
};
