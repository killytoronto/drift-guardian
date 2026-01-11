# Drift Guardian Architecture

## Overview

Drift Guardian is a static analysis tool that detects inconsistencies between:
1. **Code and Documentation** (docs-drift)
2. **Code and Business Policies** (logic-drift)

The architecture is designed for:
- **Zero external dependencies** (uses only Node.js built-ins)
- **Deterministic results** (regex-based by default)
- **Optional LLM enhancement** (semantic analysis)
- **Fast execution** (caching, incremental processing)

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Entry Points                             │
├─────────────────────────────────────────────────────────────┤
│  GitHub Action (index.js)  │  CLI Tool (cli.js)             │
└─────────────────┬───────────────────────────┬───────────────┘
                  │                           │
                  v                           v
         ┌────────────────────────────────────────┐
         │       Configuration Loader             │
         │         (config.js)                    │
         └────────────┬───────────────────────────┘
                      │
         ┌────────────┴─────────────┐
         v                          v
┌─────────────────┐        ┌─────────────────┐
│  Docs Drift     │        │  Logic Drift    │
│  Detector       │        │  Detector       │
│ (docsDrift.js)  │        │(logicDrift.js)  │
└────┬─────┬──────┘        └────┬─────┬──────┘
     │     │                    │     │
     v     v                    v     v
 ┌──────┐ ┌──────┐         ┌──────┐ ┌──────┐
 │ Code │ │ Docs │         │ Code │ │Policy│
 │ Scan │ │ Scan │         │ Scan │ │ Scan │
 └──┬───┘ └───┬──┘         └──┬───┘ └───┬──┘
    │         │               │         │
    └────┬────┘               └────┬────┘
         v                         v
    ┌─────────────┐          ┌─────────────┐
    │  Compare    │          │  Compare    │
    │  Entities   │          │  Values     │
    └──────┬──────┘          └──────┬──────┘
           │                        │
           └────────┬───────────────┘
                    v
            ┌───────────────┐
            │  LLM Client   │
            │  (optional)   │
            └───────┬───────┘
                    │
                    v
            ┌───────────────┐
            │   Reporter    │
            │  (github.js)  │
            └───────────────┘
```

## Directory Structure

```
drift-guardian/
├── src/
│   ├── index.js              # GitHub Action entry point
│   ├── cli.js                # CLI tool entry point
│   ├── config.js             # Configuration loader & validator
│   ├── git.js                # Git operations (diff, changed files)
│   │
│   ├── detectors/
│   │   ├── docsDrift.js      # Documentation drift detection (1302 lines)
│   │   └── logicDrift.js     # Policy drift detection (297 lines)
│   │
│   ├── llm/
│   │   ├── client.js         # LLM provider abstraction
│   │   └── prompts.js        # LLM prompt templates
│   │
│   ├── reporters/
│   │   └── github.js         # GitHub PR comment formatting
│   │
│   └── utils/
│       ├── cache.js          # Caching for incremental processing
│       ├── glob.js           # Glob pattern matching
│       ├── io.js             # File system utilities
│       ├── text.js           # Text parsing utilities
│       ├── yaml.js           # YAML parser (160 lines)
│       └── severity.js       # Severity normalization
│
├── test/                     # Test suite (11 files)
├── examples/                 # Working examples
├── .github/workflows/        # CI/CD automation
├── SECURITY.md               # Security policy
├── CHANGELOG.md              # Version history
└── package.json              # Package metadata

```

## Core Components

### 1. Entry Points

#### GitHub Action (src/index.js)
- Reads GitHub Actions environment variables
- Loads config from `.drift.config.yml`
- Runs detectors on changed files
- Posts results as PR comments
- Exits with code 1 if drift detected (configurable)

#### CLI Tool (src/cli.js)
- Command-line interface for local development
- Argument parsing (`--config`, `--base`, `--head`, etc.)
- Output formats: text, markdown, JSON
- Can be used in any CI/CD system

### 2. Configuration System (src/config.js)

**Responsibilities:**
- Load and parse YAML/JSON config files
- Normalize snake_case and camelCase keys
- Resolve environment variables (`${{ env.VAR }}`, `${VAR}`)
- Validate required fields
- Provide sensible defaults

**Key Features:**
- Supports both `docs-drift` and `docsDrift` naming
- Environment variable resolution with two syntaxes
- Config validation with helpful error messages
- Per-rule configuration overrides

### 3. Git Operations (src/git.js)

**Responsibilities:**
- Detect GitHub Actions context (PR number, base/head SHA)
- Get list of changed files between commits
- Get file diff for specific files
- Safe command execution with `execFileSync`

**Security:**
- Uses argument arrays (not shell strings)
- No command injection vulnerabilities
- Handles git errors gracefully

### 4. Docs Drift Detector (src/detectors/docsDrift.js)

**Line Count:** 1,302 lines (largest module)

**Responsibilities:**
- Extract entities from code files
- Extract entities from documentation files
- Compare code entities with doc entities
- Optional LLM semantic analysis

**Supported Entities:**
- Function signatures (8 languages)
- Class names
- API endpoints (REST, various frameworks)
- Environment variables
- Config keys
- CLI flags
- JSON payload keys

**Languages Supported:**
- JavaScript/TypeScript
- Python
- Go
- Ruby
- Java
- Kotlin
- C#
- Generic (basic patterns)

**Processing Flow:**
```
1. Load config & rules
2. Find code files matching patterns
3. Extract entities from code
4. Find doc files matching patterns
5. Extract entities from docs
6. Compare entities:
   - Missing in docs → Warning
   - Signature mismatch → Warning
   - Rename detected → Info
7. Optional: LLM verification
8. Return drift results
```

### 5. Logic Drift Detector (src/detectors/logicDrift.js)

**Line Count:** 297 lines

**Responsibilities:**
- Detect code changes that violate business policies
- Compare code values with policy documents
- Run deterministic regex-based rules
- Optional LLM policy contradiction detection

**Processing Flow:**
```
1. Load policy rules from config
2. Find code files matching patterns
3. Check if policy files updated
4. If not updated → Drift detected
5. Run deterministic comparisons:
   - Extract values from code (regex)
   - Extract values from policy (regex)
   - Compare with operators (eq, gt, contains, etc.)
6. Optional: LLM semantic check
7. Return drift results
```

**Comparison Operators:**
- `equals` / `eq` - Exact match
- `not_equals` / `ne` - Not equal
- `gt` - Greater than
- `gte` / `ge` - Greater than or equal
- `lt` - Less than
- `lte` / `le` - Less than or equal
- `contains` - Substring match

### 6. LLM Client (src/llm/client.js)

**Supported Providers:**
- OpenAI-compatible (OpenAI, Groq, OpenRouter, etc.)
- Ollama (local)
- Mock (testing)

**Security Features:**
- URL validation against trusted domain allowlist
- HTTPS enforcement (with warnings)
- Request timeouts (30 seconds)
- Private network detection
- Bypass option: `DRIFT_GUARDIAN_ALLOW_CUSTOM_LLM=true`

**Provider Configuration:**
```javascript
{
  provider: 'openai',           // or 'ollama', 'groq', etc.
  model: 'gpt-4',
  base_url: 'https://api.openai.com/v1',
  api_key: '${OPENAI_API_KEY}',
  temperature: 0.1,
  max_tokens: 500
}
```

### 7. Cache System (src/utils/cache.js)

**Purpose:** Speed up repeated scans by caching extracted entities

**Features:**
- Two-tier caching (in-memory + disk)
- File hash-based invalidation (mtime + size)
- Namespace support (entities, endpoints, etc.)
- Automatic cleanup of old cache entries
- Disable with `DRIFT_GUARDIAN_CACHE=false`

**Cache Structure:**
```json
{
  "hash": "1704398400000-12345",
  "timestamp": 1704398400000,
  "data": {
    "functions": [...],
    "endpoints": [...]
  }
}
```

### 8. Reporter (src/reporters/github.js)

**Responsibilities:**
- Format drift results as Markdown
- Post comments to GitHub PR via API
- Group results by severity (errors, warnings, info)

**Output Format:**
```markdown
## Drift Guardian Results

### Errors
- [docs-drift] missing-in-docs | file: src/api.js | explanation: ...

### Warnings
- [logic-drift] policy-not-updated | file: src/auth.js | ...

### Info
- [docs-drift] potential-rename | ...

---
Generated by Drift Guardian
```

## Data Flow

### 1. Documentation Drift Detection

```
Code Files → Extract Entities → Compare → Report
              ↓
Doc Files → Extract Entities ────┘
              ↓
            [Optional LLM Verification]
```

### 2. Logic Drift Detection

```
Code Changes → Get Diff → Extract Values → Compare → Report
                            ↓
Policy Files → Parse ──────┘
                            ↓
                    [Optional LLM Check]
```

## Performance Optimizations

1. **Caching**: Extracted entities cached by file hash
2. **Incremental Processing**: Only scans changed files
3. **Lazy Loading**: LLM only invoked when needed
4. **Regex Efficiency**: Compiled once, reused
5. **File Limits**: Configurable max files/entities

## Security Model

### Threat Model

**Assumed Threats:**
1. Malicious config file (untrusted repo)
2. Credential theft via malicious LLM endpoint
3. ReDoS attack via complex regex
4. Command injection via git operations
5. Path traversal via file patterns

**Mitigations:**

| Threat | Mitigation |
|--------|-----------|
| ReDoS | Pattern validation with timeout |
| URL injection | Trusted domain allowlist |
| Command injection | `execFileSync` with arrays |
| Credential theft | HTTPS enforcement, URL validation |
| Hanging requests | 30-second timeouts |
| Path traversal | Config should be trusted |

### Security Layers

1. **Input Validation**: Config, regex patterns, URLs
2. **Sandboxing**: No eval, no dynamic code
3. **Timeouts**: All external requests
4. **Allowlisting**: Trusted LLM domains
5. **Least Privilege**: Read-only file access

## Extension Points

### Adding a New Language

1. Add regex patterns to `docsDrift.js`:
   ```javascript
   function extractFunctions_NewLang(code) {
     return extractMatches(code, /pattern/g);
   }
   ```

2. Update `extractFunctions()` to call new function
3. Add tests in `test/detectors/docsDrift.test.js`

### Adding a New Entity Type

1. Add extraction function in `docsDrift.js`
2. Add to default `extract` array in config
3. Add comparison logic
4. Update documentation

### Adding a New LLM Provider

1. Add default URL in `llm/client.js`
2. Add to trusted domains list
3. Implement provider-specific API call if needed
4. Add provider to documentation

## Testing Strategy

### Unit Tests
- Individual extractors (function, endpoint, etc.)
- Config parsing and validation
- LLM client (with mocks)
- Cache functionality

### Integration Tests
- End-to-end drift detection
- GitHub Action workflow
- CLI tool with real files

### Security Tests
- ReDoS pattern validation
- URL validation edge cases
- Timeout enforcement

## Performance Benchmarks

**Typical Performance** (uncached):
- Small repo (<50 files): 1-3 seconds
- Medium repo (100-500 files): 5-15 seconds
- Large repo (1000+ files): 30-60 seconds

**With Caching** (no file changes):
- Small repo: <1 second
- Medium repo: 2-5 seconds
- Large repo: 5-15 seconds

**LLM Impact:**
- Adds 1-5 seconds per file checked
- Depends on provider latency
- Can be disabled for faster checks

## Deployment Patterns

### GitHub Actions
```yaml
- uses: actions/checkout@v4
- uses: ./path/to/drift-guardian
  with:
    config: .drift.config.yml
    llm_api_key: ${{ secrets.OPENAI_API_KEY }}
```

### GitLab CI
```yaml
drift-check:
  script:
    - npm install -g drift-guardian
    - drift-guardian --config .drift.config.yml
```

### Jenkins
```groovy
stage('Drift Check') {
  steps {
    sh 'npx drift-guardian --config .drift.config.yml'
  }
}
```

## Future Architecture

### Planned Improvements

1. **Plugin System**: Allow custom extractors
2. **Distributed Caching**: Redis/Memcached support
3. **Streaming**: Process large files in chunks
4. **Parallelization**: Multi-threaded entity extraction
5. **Web UI**: Visual configuration builder
6. **Database Backend**: Track drift over time
7. **GraphQL Support**: Query drift results

---

## Contributing

When modifying the architecture:
1. Update this document
2. Run performance benchmarks
3. Update security model if needed
4. Add integration tests
5. Update CHANGELOG.md

For questions about architecture decisions, open a GitHub Discussion.
