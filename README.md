# 🛡️ Drift Guardian

> **Automatically catch documentation drift in your PRs** - No LLM required!

[![npm version](https://img.shields.io/npm/v/drift-guardian.svg)](https://www.npmjs.com/package/drift-guardian)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/drift-guardian.svg)](https://nodejs.org)

---

## 🎯 What is this?

Ever make a code change and forget to update the docs? **Drift Guardian** catches that automatically!

```javascript
// You change this:
function getUser(id) { }

// To this:
function getUser(id, options, fields) { }

// 🚨 Drift Guardian warns: "Docs missing params: options, fields"
```

**Perfect for smaller teams who want to keep their code private!** No data sent to external LLMs - everything runs locally. 🔒

---

## ⭐ Please Star This Repo!

If you find this useful, **please give it a star!** ⭐

It helps others discover the tool and keeps me motivated to maintain it!

Also feel free to:
- 📦 Download it and use it in your projects
- 🐛 Report bugs or request features
- 🤝 Contribute improvements
- 📣 Share it with your team

**Do whatever - have fun and thanks for stopping by!** 🎉

---

## 🔒 Privacy First

**Built for teams who don't want to share sensitive data with LLMs.**

- ✅ **100% Local** - All analysis runs on your machine
- ✅ **Zero External APIs** - No data leaves your environment
- ✅ **Zero Dependencies** - No supply chain risk
- ✅ **Open Source** - Audit the code yourself

Optional LLM support is available if you want it, but the tool works great without it!

---

## 🚀 Quick Start

### Installation

```bash
npm install drift-guardian
```

### Configuration

Create `.drift.config.yml` in your repo root:

```yaml
docs-drift:
  enabled: true
  code-files:
    - src/**/*.js
    - src/**/*.py
  doc-files:
    - README.md
    - docs/**/*.md
  extract:
    - function-signatures
    - api-endpoints
    - env-variables
    - graphql-operations
    - websocket-events
    - components
    - database-models

output:
  format: text
  severity:
    docs-drift: warning
  fail-on-error: false
```

### Run It

```bash
# Run locally
GITHUB_BASE_SHA=$(git rev-parse HEAD~1) \
GITHUB_HEAD_SHA=$(git rev-parse HEAD) \
npx drift-guardian

# Or just
npx drift-guardian
```

### GitHub Action

Add `.github/workflows/drift-check.yml`:

```yaml
name: Drift Guardian

on:
  pull_request:
    branches: [main, master]

jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install Drift Guardian
        run: npm install -g drift-guardian

      - name: Check for drift
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          GITHUB_BASE_SHA=${{ github.event.pull_request.base.sha }} \
          GITHUB_HEAD_SHA=${{ github.event.pull_request.head.sha }} \
          drift-guardian
```

---

## 🎨 What Does It Detect?

### Code Elements (10+ types!)

| Type | Languages | Example |
|------|-----------|---------|
| **Functions** | JS, Python, Go, Java, C#, Ruby, Kotlin | `function getUser(id)` |
| **API Endpoints** | Express, Flask, Spring, Rails | `app.get('/users/:id')` |
| **GraphQL Operations** | All | `query GetUser { user { id } }` |
| **WebSocket Events** | Socket.io, native WS | `socket.on('message')` |
| **Components** | React, Vue, Angular | `function UserCard()` |
| **Database Models** | Prisma, TypeORM, Django, SQLAlchemy | `@Entity() class User` |
| **Environment Variables** | All | `process.env.API_KEY` |
| **Event Handlers** | DOM, EventEmitter | `.addEventListener('click')` |
| **CLI Commands** | Click, Commander.js, Cobra | `@click.command()` |
| **Test Descriptions** | Jest, pytest | `test('should work')` |

### Supported Languages

- ✅ **JavaScript/TypeScript** (Node.js, React, Vue, Angular)
- ✅ **Python** (Flask, Django, FastAPI)
- ✅ **Go** (net/http, Gin, Echo)
- ✅ **Java/Kotlin** (Spring Boot)
- ✅ **C#** (.NET, ASP.NET)
- ✅ **Ruby** (Rails, Sinatra)
- ✅ **GraphQL** (all frameworks)

---

## 💪 Real-World Example

### Before (Code Changed, Docs Stale)

**Code:**
```javascript
// Changed function signature
function getUserById(id, includeDeleted, fields) { }

// Added new endpoint
app.delete('/api/users/:id', deleteHandler);

// Added new env var
const redisUrl = process.env.REDIS_URL;
```

**Docs:**
```markdown
### getUserById(id)
...old signature

## Endpoints
- GET /users/:id
...missing DELETE endpoint

## Env Vars
- DATABASE_URL
...missing REDIS_URL
```

### Drift Guardian Output

```
WARNING | docs-drift | function-missing-params | file=users.js
  Docs for getUserById are missing params: includeDeleted, fields

WARNING | docs-drift | endpoint-missing-doc | file=api.js
  Endpoint DELETE /api/users/:id is not documented

WARNING | docs-drift | env-missing-doc | file=api.js
  Environment variable REDIS_URL is not documented
```

### After (Docs Updated)

Update your docs → No warnings! ✅

---

## ⚡ Performance

**Fast enough to run on every PR!**

| Codebase Size | Processing Time | Throughput |
|---------------|----------------|------------|
| Small (10 functions) | ~1-3ms | 12K entities/sec |
| Medium (100 functions) | ~4ms | 68K entities/sec |
| Large (500 functions) | ~35ms | 38K entities/sec |

Zero dependencies = Fast startup time! 🚀

---

## 🔧 Advanced: Policy Enforcement

Want to enforce business rules? Drift Guardian can do that too!

```yaml
logic-drift:
  enabled: true
  rules:
    - name: Rate Limiting Policy
      code-files: ['src/middleware/**/*.js']
      policy-files: ['docs/POLICIES.md']
      comparisons:
        - code_pattern: 'rateLimit:\s*(\d+)'
          policy_pattern: 'rate limit of (\d+)'
          compare: 'lte'  # Code must be <= policy
          severity: error
```

Now you can catch when code violates documented policies!

---

## 📖 Configuration Options

### Extractors

Enable/disable what to check:

```yaml
extract:
  - function-signatures      # Function params/return types
  - api-endpoints           # REST API routes
  - graphql-operations      # GraphQL queries/mutations
  - websocket-events        # WebSocket event handlers
  - env-variables           # Environment variables
  - components             # React/Vue/Angular components
  - database-models        # ORM models
  - event-handlers         # DOM/EventEmitter handlers
  - cli-commands           # CLI commands
  - test-descriptions      # Test cases
  - payload-keys           # JSON payload keys
```

### Output Formats

```yaml
output:
  format: text           # or 'json' or 'github-comment'
  severity:
    docs-drift: warning  # or 'error' or 'info'
  fail-on-error: false   # Set to true to fail CI
```

### Full Scan

```yaml
docs-drift:
  full-scan: auto        # or true/false
  full-scan-max-files: 200
```

---

## 🧪 Testing

```bash
# Run all tests (76 tests)
npm test

# Run with coverage
npm run test:coverage

# Run benchmarks
npm run benchmark

# Lint code
npm run lint

# Type check
npm run typecheck
```

All tests passing! ✅

---

## 🛠️ Development

### Project Structure

```
drift-guardian/
├── src/
│   ├── index.js              # GitHub Action entry point
│   ├── cli.js                # CLI entry point
│   ├── config.js             # Configuration parser
│   ├── detectors/
│   │   ├── docsDrift.js      # Documentation drift detection
│   │   └── logicDrift.js     # Policy drift detection
│   ├── llm/
│   │   ├── client.js         # Optional LLM client
│   │   └── prompts.js        # LLM prompts
│   ├── reporters/
│   │   └── github.js         # GitHub comment formatting
│   ├── utils/
│   │   ├── glob.js           # File pattern matching
│   │   ├── io.js             # File I/O
│   │   ├── text.js           # Text utilities
│   │   └── severity.js       # Severity normalization
│   └── types.d.ts            # TypeScript type definitions
├── test/                     # 76 comprehensive tests
└── examples/                 # Usage examples
```

### Contributing

PRs welcome! Please:
1. Add tests for new features
2. Run `npm run lint` before committing
3. Update docs for user-facing changes

---

## 🎓 How It Works

1. **Extract** - Scans changed code files for functions, APIs, env vars, etc.
2. **Compare** - Checks if documentation mentions these elements
3. **Report** - Warns about missing or outdated docs
4. **Optional LLM** - Can use LLM for deeper semantic analysis (but not required!)

All regex patterns are protected against ReDoS attacks. All inputs are validated for safety.

---

## 🙏 Acknowledgments

**This project was built with assistance from:**
- 🤖 **Claude Code** - Anthropic's AI coding assistant
- 🤖 **Codex** - OpenAI's code generation model

These tools helped accelerate development, but **the code is 100% human-reviewed and tested!**

Special thanks to the open-source community for inspiration and feedback! ❤️

---

## 📜 License

MIT License - see [LICENSE](LICENSE) file for details.

**TL;DR:** Do whatever you want with it! Commercial use, modification, distribution - all allowed! 🎉

---

## 🌟 Star History

If this helped you, please star the repo! ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=yourusername/drift-guardian&type=Date)](https://star-history.com/#yourusername/drift-guardian&Date)

---

## 💬 Support & Community

- 🐛 **Bug Reports:** [GitHub Issues](https://github.com/yourusername/drift-guardian/issues)
- 💡 **Feature Requests:** [GitHub Issues](https://github.com/yourusername/drift-guardian/issues)
- 📣 **Discussions:** [GitHub Discussions](https://github.com/yourusername/drift-guardian/discussions)
- 📖 **Documentation:** You're reading it! 😄

---

## 🎉 Thanks for Stopping By!

Whether you're here to:
- ⭐ **Star it** - Thanks! You're awesome!
- 📦 **Use it** - Hope it saves you time!
- 🐛 **Report a bug** - Appreciate your help!
- 🤝 **Contribute** - You rock!
- 👀 **Just browsing** - Hope you learned something!

**Do whatever - have fun!**

Built with ❤️ for teams who care about documentation but don't want to share code with external services.

---

## 🚀 What's Next?

### Roadmap
- [ ] VSCode extension
- [ ] More language support (Rust, PHP, Swift)
- [ ] Better diff visualization
- [ ] Custom extractor plugins
- [ ] Web dashboard

Want to help? PRs welcome! 🙌

---

**Now go catch some drift! 🏄‍♂️**
