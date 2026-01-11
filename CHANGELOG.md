# Changelog

All notable changes to Drift Guardian will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2024-01-04

### Added
- **Security**: ReDoS protection for user-supplied regex patterns
- **Security**: URL validation for LLM endpoints to prevent credential theft
- **Security**: Request timeouts (30s) for all HTTP requests
- **Security**: HTTPS enforcement for non-local LLM endpoints
- **Performance**: Caching system for incremental processing (`src/utils/cache.js`)
- **DevOps**: ESLint configuration for code quality
- **DevOps**: CI/CD workflow with GitHub Actions
- **DevOps**: Multi-platform testing (Ubuntu, macOS, Windows)
- **DevOps**: Multi-version Node.js testing (18, 20, 22)
- **Documentation**: Comprehensive SECURITY.md
- **Documentation**: CHANGELOG.md
- **Documentation**: Architecture documentation
- npm scripts: `lint:fix`, `test:coverage`, `validate`
- Environment variable: `DRIFT_GUARDIAN_ALLOW_CUSTOM_LLM` for custom endpoints
- Environment variable: `DRIFT_GUARDIAN_CACHE` to disable caching
- Package keywords for better discoverability

### Fixed
- **Critical**: Greedy JSON regex in `utils/text.js:14` (security fix)
- **Critical**: Character class escape bug in `detectors/docsDrift.js:1294`
- **Critical**: Backslash detection error in `detectors/docsDrift.js:1220`
- Better error messages for invalid regex patterns
- Improved error handling in LLM client

### Changed
- Version bump from 0.1.0 to 0.2.0
- Package now requires Node.js >= 18.0.0
- Enhanced security model with allowlist-based validation
- Improved code quality with ESLint rules

### Security
- **CRITICAL**: Fixed ReDoS vulnerability in regex pattern execution
- **CRITICAL**: Fixed URL injection vulnerability in LLM client
- **CRITICAL**: Added request timeouts to prevent hanging pipelines
- Added trusted domain allowlist for LLM providers
- Added warnings for insecure HTTP connections

## [0.1.0] - 2024-01-03

### Added
- Initial release
- Documentation drift detection
- Logic drift detection
- Multi-language support (JavaScript, TypeScript, Python, Go, Ruby, Java, Kotlin, C#)
- Function signature extraction
- API endpoint detection
- Environment variable tracking
- Config key monitoring
- CLI flag detection
- JSON payload key rename detection
- Optional LLM integration (Ollama, OpenAI-compatible)
- GitHub Action integration
- CLI tool (`drift-guardian`)
- Comprehensive test suite (11 test files)
- Examples directory

### Features
- Zero external runtime dependencies
- Deterministic regex-based detection
- Optional LLM semantic analysis
- Configurable via YAML/JSON
- GitHub PR comment reporting
- Support for multiple LLM providers

## [Unreleased]

### Planned
- Plugin system for custom extractors
- Web UI for configuration
- Analytics dashboard
- Auto-fix suggestions
- GitLab CI integration
- Bitbucket Pipelines integration
- Performance benchmarks
- Rate limiting for LLM calls
- Retry logic with exponential backoff
- Structured JSON logging
- Progress indicators for long scans

---

## Release Notes

### Upgrading from 0.1.0 to 0.2.0

**Breaking Changes**: None

**Action Required**:
1. Run `npm install eslint --save-dev` to get linting support
2. Review your LLM `base_url` configurations - ensure they're trusted domains
3. Complex regex patterns in `logic-drift` rules may now be rejected (add simpler patterns)

**New Features**:
- Caching is enabled by default. Disable with `export DRIFT_GUARDIAN_CACHE=false`
- Custom LLM endpoints require trust validation (see SECURITY.md)

**Security Fixes**:
All users should upgrade immediately due to critical security fixes in ReDoS and URL injection vulnerabilities.

---

## Version Support

| Version | Support Status | End of Life |
|---------|---------------|-------------|
| 0.2.x   | ✅ Supported  | -           |
| 0.1.x   | ⚠️ Security fixes only | 2024-03-01 |

## Links

- [GitHub Repository](https://github.com/yourusername/drift-guardian)
- [Issue Tracker](https://github.com/yourusername/drift-guardian/issues)
- [Security Policy](./SECURITY.md)
- [Contributing Guide](./CONTRIBUTING.md)
