# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| 0.1.x   | No        |

## Security Features

Drift Guardian implements multiple security layers to protect your codebase and credentials:

### 1. Zero External Runtime Dependencies
- No npm packages in production dependencies
- Uses only Node.js built-in modules
- Minimal supply chain attack surface

### 2. Command Injection Protection
- Uses `execFileSync` with argument arrays instead of shell strings
- No dynamic command construction
- Safe git command execution

### 3. ReDoS (Regular Expression Denial of Service) Protection
- User-supplied regex patterns are validated before execution
- Timeout-based validation detects catastrophic backtracking
- Patterns that take >100ms on test cases are rejected

### 4. URL Injection Protection
- LLM endpoints are validated against an allowlist of trusted domains
- Supports private/internal domains (`.internal`, `.local`, `.corp`)
- Prevents credential theft via malicious `base_url` configurations
- Environment variable `DRIFT_GUARDIAN_ALLOW_CUSTOM_LLM=true` available for advanced users

### 5. Request Timeouts
- All HTTP requests (LLM, GitHub API) have 30-second timeouts
- Prevents hanging CI/CD pipelines
- Protects against slow-loris style attacks

### 6. Secrets Management
- API keys must be provided via environment variables
- Supports GitHub Actions secret syntax: `${{ env.VAR_NAME }}`
- No hardcoded credentials in codebase
- `.env` files excluded from git

### 7. HTTPS Enforcement
- Non-local endpoints should use HTTPS
- Warning displayed for HTTP non-localhost connections
- API keys transmitted only over secure channels

## Trusted LLM Providers

The following LLM provider domains are trusted by default:

- api.openai.com
- api.anthropic.com
- api.groq.com
- openrouter.ai
- api.llm7.io
- api.together.xyz
- api.mistral.ai
- api.cohere.ai
- generativelanguage.googleapis.com (Google AI)
- localhost / 127.0.0.1 (for Ollama)

### Using Custom LLM Endpoints

For private/internal LLM deployments:

1. **Internal domains** (`.internal`, `.local`, `.corp`, `.lan`) are automatically allowed with a warning
2. **Private networks** (10.x.x.x, 192.168.x.x, 172.16-31.x.x) are allowed
3. **Bypass validation** (use with caution):
   ```bash
   export DRIFT_GUARDIAN_ALLOW_CUSTOM_LLM=true
   ```

## Security Best Practices

### For Users

1. **Keep secrets in environment variables**
   ```yaml
   llm:
     enabled: true
     api_key: ${{ env.OPENAI_API_KEY }}  # Good
     # api_key: sk-abc123...  # BAD - never hardcode
   ```

2. **Use HTTPS for remote endpoints**
   ```yaml
   llm:
     base_url: https://api.openai.com/v1  # Good
     # base_url: http://example.com/v1    # BAD - insecure
   ```

3. **Review config patterns before running**
   - Regex patterns in `logic-drift.comparisons` are executed
   - Avoid overly complex patterns
   - Test patterns on small files first

4. **Limit file access**
   ```yaml
   docs-drift:
     code-files:
       - "src/**/*.js"  # Good - specific
       # - "**/*"       # BAD - too broad
   ```

5. **Keep dependencies updated**
   ```bash
   npm audit
   npm update
   ```

### For Contributors

1. **Never use `eval()` or `Function()`**
2. **Always validate user input**
3. **Use `execFileSync()` for subprocesses, never `exec()`**
4. **Add timeout to all external requests**
5. **Sanitize error messages (no internal paths/tokens)**
6. **Run security tests before committing**:
   ```bash
   npm run validate
   npm audit
   ```

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please:

1. **DO NOT** open a public GitHub issue
2. Email security details to: [REPLACE_WITH_YOUR_EMAIL]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and provide updates every 7 days until resolved.

### Disclosure Policy

- **Private disclosure first**: Give us time to fix before public disclosure
- **Coordinated disclosure**: We'll work with you on timing
- **Credit**: Security researchers will be credited in release notes (unless anonymity requested)

## Security Audit History

| Date       | Auditor        | Findings | Status   |
|------------|----------------|----------|----------|
| 2024-01-04 | Internal       | 3 issues | Resolved |

## Known Limitations

1. **Path traversal**: File patterns are trusted from config. Use caution with user-supplied patterns.
2. **Regex complexity**: While ReDoS-protected, extremely complex patterns may be slow.
3. **LLM responses**: Non-deterministic; can be manipulated by prompt injection (severity: low).
4. **Cache poisoning**: Cache stored in `.drift-cache` is not integrity-checked.

## Security Checklist for Deployment

- [ ] API keys stored in GitHub Secrets or CI/CD vault
- [ ] Config file reviewed for suspicious patterns
- [ ] Using latest version of Drift Guardian
- [ ] LLM endpoint is trusted or internal
- [ ] File patterns limit access to necessary directories only
- [ ] HTTPS enabled for all remote endpoints
- [ ] npm audit passed with no critical vulnerabilities
- [ ] Tests passing on CI/CD

## License

This security policy is part of the Drift Guardian project, licensed under MIT.
