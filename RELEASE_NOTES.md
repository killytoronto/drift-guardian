# Drift Guardian v0.2.0 - Initial Release

Automatically catch documentation drift in your PRs - No LLM required!

Built for smaller teams who don't want to share sensitive data with LLMs. Everything runs locally.

---

## What Does It Do?

Ever change code and forget to update the docs? Drift Guardian catches that automatically:

```javascript
// You change this:
function getUser(id) { }

// To this:
function getUser(id, options, fields) { }

// Drift Guardian warns: "Docs missing params: options, fields"
```

---

## Features

### Code Element Detection (10+ types)
- Functions (JS, Python, Go, Java, C#, Ruby, Kotlin)
- API Endpoints (Express, Flask, Spring, Rails, etc.)
- GraphQL Operations (queries, mutations, subscriptions)
- WebSocket Events (Socket.io, native WebSocket)
- Components (React, Vue, Angular)
- Database Models (Prisma, TypeORM, Django, SQLAlchemy)
- Environment Variables (all languages)
- Event Handlers (DOM, EventEmitter)
- CLI Commands (Click, Commander.js, Cobra)
- Test Descriptions (Jest, pytest)

### Multi-Language Support
- JavaScript/TypeScript (Node.js, React, Vue, Angular)
- Python (Flask, Django, FastAPI)
- Go (net/http, Gin, Echo)
- Java/Kotlin (Spring Boot)
- C# (.NET, ASP.NET)
- Ruby (Rails, Sinatra)
- GraphQL (all frameworks)

### Privacy & Security
- 100% Local - No data sent to external services
- Zero Dependencies - No supply chain risk
- ReDoS Protection - All regex patterns validated
- Input Validation - File size limits, binary detection

### Performance
- Fast - 35ms for 500 functions
- Efficient - 36K-91K entities/second throughput
- CI-Ready - Fast enough for every PR

### Quality
- 76 Tests - Comprehensive test coverage
- TypeScript Types - Full JSDoc + TypeScript validation
- ESLint Clean - 0 errors
- Error Recovery - Graceful handling of edge cases

---

## Quick Start

### Installation

```bash
npm install drift-guardian
```

### Configuration

Create `.drift.config.yml`:

```yaml
docs-drift:
  enabled: true
  code-files: ['src/**/*.js']
  doc-files: ['README.md']
  extract:
    - function-signatures
    - api-endpoints
    - env-variables
```

### Run It

```bash
npx drift-guardian
```

### GitHub Action

```yaml
- uses: actions/setup-node@v3
- run: npm install -g drift-guardian
- run: drift-guardian
```

---

## What's Included

- Full source code (src/)
- 76 comprehensive tests
- TypeScript type definitions
- Example configurations
- Documentation

---

## Acknowledgments

Built with assistance from:
- Claude Code - Anthropic's AI coding assistant
- Codex - OpenAI's code generation model

All code is human-reviewed and tested!

---

## Please Star

If you find this useful, please give it a star!

Also feel free to:
- Use it in your projects
- Report bugs
- Contribute
- Share with your team

Do whatever - have fun and thanks for stopping by!

---

## Documentation

Full docs: https://github.com/killytoronto/drift-guardian#readme

---

## Links

- GitHub: https://github.com/killytoronto/drift-guardian
- Issues: https://github.com/killytoronto/drift-guardian/issues
- npm: Coming soon!

---

Built for teams who care about documentation but don't want to share code with external services.
