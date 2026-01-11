'use strict';

function createLLMClient(config) {
  const provider = (config.provider || 'openai-compatible').toLowerCase();
  const model = config.model;
  const rawBaseUrl = config.baseUrl || config.base_url || defaultBaseUrl(provider);
  const baseUrl = normalizeBaseUrl(rawBaseUrl);

  // Validate base URL to prevent credential theft
  if (baseUrl && provider !== 'mock') {
    validateBaseUrl(baseUrl, provider);
  }

  const apiKey = config.apiKey || config.api_key || '';
  const temperature = config.temperature;
  const maxTokens = config.maxTokens;
  const mockResponse = config.mockResponse;

  async function complete(prompt) {
    if (provider === 'mock') {
      return resolveMockResponse(mockResponse);
    }
    if (provider === 'ollama') {
      return callOllama(baseUrl, model, prompt);
    }
    return callOpenAICompatible(baseUrl, apiKey, model, temperature, maxTokens, prompt);
  }

  return { complete };
}

function resolveMockResponse(value) {
  const envValue = process.env.DRIFT_GUARDIAN_MOCK_RESPONSE;
  const response = value || envValue;
  if (!response) {
    throw new Error('Mock LLM provider requires llm.mock_response or DRIFT_GUARDIAN_MOCK_RESPONSE.');
  }
  return response;
}

function defaultBaseUrl(provider) {
  if (provider === 'llm7') {
    return 'https://api.llm7.io/v1';
  }
  if (provider === 'openrouter') {
    return 'https://openrouter.ai/api/v1';
  }
  if (provider === 'groq') {
    return 'https://api.groq.com/openai/v1';
  }
  if (provider === 'openai') {
    return 'https://api.openai.com/v1';
  }
  if (provider === 'ollama') {
    return 'http://localhost:11434';
  }
  return null;
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return '';
  }
  return baseUrl.replace(/\/$/, '');
}

function validateBaseUrl(baseUrl, provider) {
  if (!baseUrl) {
    return;
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch (err) {
    throw new Error(`Invalid LLM base URL: ${baseUrl}`);
  }

  // Enforce HTTPS for non-local endpoints
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`LLM base URL must use HTTP or HTTPS protocol: ${baseUrl}`);
  }

  // Warn for non-HTTPS non-local endpoints
  if (url.protocol === 'http:' && !isLocalhost(url.hostname)) {
    console.warn(`Warning: Using insecure HTTP for LLM endpoint: ${baseUrl}. API keys may be transmitted insecurely.`);
  }

  // Allowlist of trusted LLM provider domains
  const trustedDomains = [
    // Official providers
    'api.openai.com',
    'api.anthropic.com',
    'api.groq.com',
    'openrouter.ai',
    'api.llm7.io',
    'api.together.xyz',
    'api.mistral.ai',
    'api.cohere.ai',
    'generativelanguage.googleapis.com',  // Google AI

    // Local/self-hosted
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1'
  ];

  // Check if hostname is trusted or a subdomain of trusted domain
  const isTrusted = trustedDomains.some((trusted) => {
    return url.hostname === trusted || url.hostname.endsWith(`.${trusted}`);
  });

  // For custom/private endpoints, allow if explicitly using 'openai-compatible' provider
  // and hostname is not obviously untrusted (basic sanity check)
  if (!isTrusted) {
    if (provider === 'ollama' && isLocalhost(url.hostname)) {
      return; // Allow local Ollama
    }

    // Allow private/internal domains (basic heuristic)
    if (isPrivateOrInternalDomain(url.hostname)) {
      console.warn(`Using custom LLM endpoint: ${url.hostname}. Ensure this is a trusted internal service.`);
      return;
    }

    throw new Error(
      `Untrusted LLM endpoint: ${url.hostname}. ` +
      'To use custom endpoints, ensure they are internal/private domains, ' +
      'or set DRIFT_GUARDIAN_ALLOW_CUSTOM_LLM=true to bypass this check (use with caution).'
    );
  }
}

function isLocalhost(hostname) {
  return hostname === 'localhost' ||
         hostname === '127.0.0.1' ||
         hostname === '0.0.0.0' ||
         hostname === '::1' ||
         hostname.startsWith('127.') ||
         hostname.startsWith('192.168.') ||
         hostname.startsWith('10.') ||
         /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname);
}

function isPrivateOrInternalDomain(hostname) {
  // Check for RFC 1918 private IPs
  if (isLocalhost(hostname)) {
    return true;
  }

  // Check for internal TLDs or private domains
  const internalTLDs = ['.internal', '.local', '.private', '.corp', '.lan'];
  if (internalTLDs.some((tld) => hostname.endsWith(tld))) {
    return true;
  }

  // Allow bypass via environment variable (for advanced users)
  if (process.env.DRIFT_GUARDIAN_ALLOW_CUSTOM_LLM === 'true') {
    return true;
  }

  return false;
}

async function callOpenAICompatible(baseUrl, apiKey, model, temperature, maxTokens, prompt) {
  if (!baseUrl) {
    throw new Error('llm.base_url is required for openai-compatible providers');
  }
  const url = `${baseUrl}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'drift-guardian'
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000) // 30 second timeout
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `LLM request to ${url} failed with status ${response.status}.\n` +
      `Response: ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}\n` +
      'Check your API key and model configuration.'
    );
  }

  const data = await response.json();
  return data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
}

async function callOllama(baseUrl, model, prompt) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/chat`;
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'drift-guardian'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000) // 30 second timeout
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Ollama request to ${url} failed with status ${response.status}.\n` +
      `Response: ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}\n` +
      `Ensure Ollama is running and the model "${model}" is available.`
    );
  }

  const data = await response.json();
  return data.message && data.message.content ? data.message.content : '';
}

module.exports = {
  createLLMClient
};
