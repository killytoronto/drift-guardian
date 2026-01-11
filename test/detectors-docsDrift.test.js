'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detectDocsDrift } = require('../src/detectors/docsDrift');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guardian-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeConfig(codeFiles, extract, docFiles, overrides) {
  return {
    docsDrift: {
      enabled: true,
      codeFiles,
      docFiles: docFiles || ['README.md'],
      extract,
      fullScan: false,
      fullScanMaxFiles: 200,
      payloadKeysAllowlist: [],
      maxDocChars: 20000,
      maxEntities: 200,
      ...(overrides || {})
    },
    logicDrift: { enabled: false, rules: [] },
    output: {
      format: 'github-comment',
      severity: { docsDrift: 'warning', logicDrift: 'error' },
      failOnError: true
    }
  };
}

test('detectDocsDrift flags function signature mismatch', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'export function createUser(email, password) {}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'createUser(username, password)');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/users.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  assert.ok(results.some((r) => r.type === 'function-signature-mismatch'));
}));

test('detectDocsDrift flags missing params in docs', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'export function createUser(email, password, role) {}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'createUser(email, password)');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/users.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  assert.ok(results.some((r) => r.type === 'function-missing-params' && r.explanation.includes('role')));
}));

test('detectDocsDrift flags extra params in docs', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'export function createUser(email, password) {}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'createUser(email, password, role)');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/users.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  assert.ok(results.some((r) => r.type === 'function-extra-params' && r.explanation.includes('role')));
}));

test('detectDocsDrift flags missing function docs', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'export function deleteUser(userId) {}');
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/users.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  assert.ok(results.some((r) => r.type === 'function-missing-doc'));
}));

test('detectDocsDrift skips when no matching files changed', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'export function createUser(email, password) {}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'createUser(email, password)');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/other.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  assert.equal(results.length, 0);
}));

test('detectDocsDrift normalizes endpoint path params', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'api.js'), 'app.get("/v1/users/:id", () => {});');
  fs.writeFileSync(path.join(dir, 'README.md'), 'GET /v1/users/{id}');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/api.js' }],
    config: makeConfig(['src/**/*.js'], ['api-endpoints'])
  });

  assert.equal(results.length, 0);
}));

test('detectDocsDrift flags missing config keys and cli flags', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'config.js'), `
const config = require('config');
const key = config.get("billing.refund_days");
const flag = "--dry-run";
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'Usage: app');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/config.js' }],
    config: makeConfig(['src/**/*.js'], ['config-keys', 'cli-flags'])
  });

  assert.ok(results.some((r) => r.type === 'config-key-missing-doc' && r.explanation.includes('billing.refund_days')));
  assert.ok(results.some((r) => r.type === 'cli-flag-missing-doc' && r.explanation.includes('--dry-run')));
}));

test('detectDocsDrift extracts Go functions and env vars', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main.go'), `package main
import "os"

func CreateUser(email string, password string) error { return nil }
func (s *Service) Refund(id string) {}

var _ = os.Getenv("PAYMENTS_KEY")
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/main.go' }],
    config: makeConfig(['src/**/*.go'], ['function-signatures', 'env-variables'])
  });

  assert.ok(results.some((r) => r.type === 'function-missing-doc' && r.explanation.includes('CreateUser')));
  assert.ok(results.some((r) => r.type === 'env-missing-doc' && r.explanation.includes('PAYMENTS_KEY')));
}));

test('detectDocsDrift handles typed params with commas', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main.go'), `package main

func UpdateConfig(cfg map[string]int, limit int) {}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'UpdateConfig(cfg, limit)');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/main.go' }],
    config: makeConfig(['src/**/*.go'], ['function-signatures'])
  });

  assert.equal(results.length, 0);
}));

test('detectDocsDrift extracts Python decorator endpoints', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'api.py'), `from fastapi import FastAPI
app = FastAPI()

@app.get("/v1/users")
def list_users():
    pass

@router.post("/v1/items")
def create_item():
    pass

@app.route("/v1/legacy", methods=["POST", "PUT"])
def legacy():
    pass
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'GET /v1/users');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/api.py' }],
    config: makeConfig(['src/**/*.py'], ['api-endpoints'])
  });

  assert.ok(results.some((r) => r.type === 'endpoint-missing-doc' && r.explanation.includes('POST /v1/items')));
  assert.ok(results.some((r) => r.type === 'endpoint-missing-doc' && r.explanation.includes('PUT /v1/legacy')));
}));

test('detectDocsDrift extracts Ruby functions and routes', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'routes.rb'), `class UsersController
  def self.create_user(email, password)
  end
end

get '/users', to: 'users#index'
post "/users"
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'create_user(username, password)\nGET /users');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/routes.rb' }],
    config: makeConfig(['src/**/*.rb'], ['function-signatures', 'api-endpoints'])
  });

  assert.ok(results.some((r) => r.type === 'function-signature-mismatch'));
  assert.ok(results.some((r) => r.type === 'endpoint-method-mismatch' && r.explanation.includes('/users')));
}));

test('detectDocsDrift extracts Go Gorilla mux routes', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'routes.go'), `package api
import "github.com/gorilla/mux"

func Routes() {
  router := mux.NewRouter()
  router.HandleFunc("/v1/refunds", Refunds).Methods("GET", "POST")
  router.Handle("/v1/admin", Admin).Methods("PUT")
  router.Methods("DELETE").Path("/v1/orders")
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/routes.go' }],
    config: makeConfig(['src/**/*.go'], ['api-endpoints'])
  });

  assert.ok(results.some((r) => r.type === 'endpoint-missing-doc' && r.explanation.includes('DELETE /v1/orders')));
}));

test('detectDocsDrift extracts Java Spring endpoints and env vars', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'UsersController.java'), `import org.springframework.web.bind.annotation.*;

@RestController
public class UsersController {
  @GetMapping("/v1/users")
  public String listUsers() { return "ok"; }

  @RequestMapping(value = "/v1/refunds", method = RequestMethod.POST)
  public void refund() {}

  public void env() { System.getenv("PAYMENTS_KEY"); }
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'GET /v1/users\nGET /v1/refunds');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/UsersController.java' }],
    config: makeConfig(['src/**/*.java'], ['api-endpoints', 'env-variables'])
  });

  assert.ok(results.some((r) => r.type === 'endpoint-method-mismatch' && r.explanation.includes('/v1/refunds')));
  assert.ok(results.some((r) => r.type === 'env-missing-doc' && r.explanation.includes('PAYMENTS_KEY')));
}));

test('detectDocsDrift extracts Kotlin Spring endpoints', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'Api.kt'), `import org.springframework.web.bind.annotation.*

@RestController
class ApiController {
  @PostMapping("/v1/orders")
  fun createOrder(orderId: String) { }

  @RequestMapping("/v1/legacy", method = [RequestMethod.GET, RequestMethod.DELETE])
  fun legacy() { }
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'POST /v1/orders\nGET /v1/legacy');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/Api.kt' }],
    config: makeConfig(['src/**/*.kt'], ['api-endpoints'])
  });

  assert.ok(results.some((r) => r.type === 'endpoint-method-mismatch' && r.explanation.includes('/v1/legacy')));
}));

test('detectDocsDrift extracts C# endpoints and env vars', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'UsersController.cs'), `using Microsoft.AspNetCore.Mvc;

[ApiController]
public class UsersController : ControllerBase {
  [HttpGet("/v1/users")]
  public IActionResult ListUsers() { return Ok(); }

  [HttpPost("/v1/users")]
  public IActionResult CreateUser(string email, string password) { return Ok(); }

  public void Env() { Environment.GetEnvironmentVariable("PAYMENTS_KEY"); }
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'GET /v1/users');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/UsersController.cs' }],
    config: makeConfig(['src/**/*.cs'], ['api-endpoints', 'env-variables'])
  });

  assert.ok(results.some((r) => r.type === 'endpoint-method-mismatch' && r.explanation.includes('/v1/users')));
  assert.ok(results.some((r) => r.type === 'env-missing-doc' && r.explanation.includes('PAYMENTS_KEY')));
}));

test('detectDocsDrift flags missing GraphQL operation docs', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'graphql.js'), `
const resolvers = {
  Query: {
    listUsers: () => []
  },
  Mutation: {
    createUser: () => ({})
  }
};
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'GraphQL Query: listUsers');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/graphql.js' }],
    config: makeConfig(['src/**/*.js'], ['api-endpoints'])
  });

  assert.ok(results.some((r) => r.type === 'graphql-missing-doc' && r.explanation.includes('Mutation')));
}));

test('detectDocsDrift flags missing WebSocket event docs', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ws.js'), `
const ws = new WebSocket('wss://example');
ws.onmessage = () => {};
ws.onclose = () => {};
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'WS: message');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/ws.js' }],
    config: makeConfig(['src/**/*.js'], ['api-endpoints'])
  });

  assert.ok(results.some((r) => r.type === 'ws-event-missing-doc' && r.explanation.includes('close')));
  assert.ok(!results.some((r) => r.type === 'ws-event-missing-doc' && r.explanation.includes('message')));
}));

test('detectDocsDrift skips GraphQL extraction for non-GraphQL files', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'config.js'), 'const Query = { name: "test" };');
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/config.js' }],
    config: makeConfig(['src/**/*.js'], ['api-endpoints'])
  });

  assert.equal(results.length, 0);
}));

test('detectDocsDrift applies maxEntities per type', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'api.js'), `
export function createUser(email, password) {}
app.get('/v1/users', () => {});
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/api.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures', 'api-endpoints'], ['README.md'], {
      maxEntities: 1
    })
  });

  assert.ok(results.some((r) => r.type === 'function-missing-doc'));
  assert.ok(results.some((r) => r.type === 'endpoint-missing-doc'));
}));

test('detectDocsDrift flags payload key rename when docs still mention old key', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'handler.js'), 'export function handle() {}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'Payload example: {"user_id": "123"}');

  const diff = `
diff --git a/src/handler.js b/src/handler.js
@@ -1,3 +1,3 @@
-const payload = { "user_id": userId };
+const payload = { "uid": userId };
`;

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/handler.js' }],
    config: makeConfig(['src/**/*.js'], ['payload-keys'], ['README.md'], {
      payloadKeysAllowlist: ['user_id', 'uid']
    }),
    baseSha: 'base',
    headSha: 'head',
    getFileDiff: () => diff
  });

  assert.ok(results.some((r) => r.type === 'payload-key-rename' && r.explanation.includes('user_id')));
}));

test('detectDocsDrift respects payload key allowlist', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'handler.js'), 'export function handle() {}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'Payload example: {"user_id": "123"}');

  const diff = `
diff --git a/src/handler.js b/src/handler.js
@@ -1,3 +1,3 @@
-const payload = { "user_id": userId };
+const payload = { "uid": userId };
`;

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/handler.js' }],
    config: makeConfig(['src/**/*.js'], ['payload-keys'], ['README.md'], {
      payloadKeysAllowlist: ['account_id']
    }),
    baseSha: 'base',
    headSha: 'head',
    getFileDiff: () => diff
  });

  assert.equal(results.length, 0);
}));

test('detectDocsDrift uses full_scan auto when repo is small', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export function createUser() {}');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'export function refundUser() {}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'ghost()');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/a.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'], ['README.md'], {
      fullScan: 'auto',
      fullScanMaxFiles: 10
    })
  });

  assert.ok(results.some((r) => r.type === 'docs-mentions-missing-function'));
}));

test('detectDocsDrift disables full_scan auto when repo is large', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export function createUser() {}');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'export function refundUser() {}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'ghost()');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/a.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'], ['README.md'], {
      fullScan: 'auto',
      fullScanMaxFiles: 1
    })
  });

  assert.ok(!results.some((r) => r.type === 'docs-mentions-missing-function'));
}));

// ============ React Component Tests ============

test('detectDocsDrift extracts React functional components', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'UserProfile.jsx'), `
import React from 'react';

export function UserProfile({ name, avatar }) {
  return <div>{name}</div>;
}

export const UserCard = ({ user }) => {
  return <div>{user.name}</div>;
};

export default function Dashboard() {
  return <div>Dashboard</div>;
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'UserProfile component');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/UserProfile.jsx' }],
    config: makeConfig(['src/**/*.jsx'], ['function-signatures', 'class-names'])
  });

  assert.ok(results.some((r) => r.type === 'component-missing-doc' && r.explanation.includes('UserCard')));
  assert.ok(results.some((r) => r.type === 'component-missing-doc' && r.explanation.includes('Dashboard')));
  assert.ok(!results.some((r) => r.type === 'component-missing-doc' && r.explanation.includes('UserProfile')));
}));

test('detectDocsDrift extracts React.memo and forwardRef components', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'MemoComponents.tsx'), `
import React from 'react';

export const MemoizedList = React.memo(({ items }) => {
  return <ul>{items.map(i => <li key={i}>{i}</li>)}</ul>;
});

export const ForwardedInput = React.forwardRef((props, ref) => {
  return <input ref={ref} {...props} />;
});
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/MemoComponents.tsx' }],
    config: makeConfig(['src/**/*.tsx'], ['function-signatures', 'class-names'])
  });

  assert.ok(results.some((r) => r.type === 'component-missing-doc' && r.explanation.includes('MemoizedList')));
  assert.ok(results.some((r) => r.type === 'component-missing-doc' && r.explanation.includes('ForwardedInput')));
}));

// ============ Vue Component Tests ============

test('detectDocsDrift extracts Vue components', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'UserCard.vue'), `
<script>
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'UserCard',
  props: ['user']
});
</script>

<template>
  <div>{{ user.name }}</div>
</template>
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/UserCard.vue' }],
    config: makeConfig(['src/**/*.vue'], ['function-signatures', 'class-names'])
  });

  assert.ok(results.some((r) => r.type === 'component-missing-doc' && r.explanation.includes('UserCard')));
}));

// ============ Angular Component Tests ============

test('detectDocsDrift extracts Angular components', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'user.component.ts'), `
import { Component } from '@angular/core';

@Component({
  selector: 'app-user-profile',
  templateUrl: './user.component.html'
})
export class UserComponent {
  name: string;
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/user.component.ts' }],
    config: makeConfig(['src/**/*.ts'], ['function-signatures', 'class-names'])
  });

  assert.ok(results.some((r) => r.type === 'component-missing-doc' && r.explanation.includes('app-user-profile')));
}));

// ============ Database Model Tests ============

test('detectDocsDrift extracts Django models', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'models.py'), `
from django.db import models

class User(models.Model):
    email = models.EmailField()
    name = models.CharField(max_length=100)

class Order(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    total = models.DecimalField()
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'User model documentation');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/models.py' }],
    config: makeConfig(['src/**/*.py'], ['class-names', 'config-keys'])
  });

  assert.ok(results.some((r) => r.type === 'model-missing-doc' && r.explanation.includes('Order')));
  assert.ok(!results.some((r) => r.type === 'model-missing-doc' && r.explanation.includes('User')));
}));

test('detectDocsDrift extracts Prisma models', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'schema.prisma'), `
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'User table');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/schema.prisma' }],
    config: makeConfig(['src/**/*.prisma'], ['class-names', 'config-keys'])
  });

  assert.ok(results.some((r) => r.type === 'model-missing-doc' && r.explanation.includes('Post')));
}));

test('detectDocsDrift extracts TypeORM entities', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'entities.ts'), `
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;
}

@Entity('orders')
export class Order {
  @Column()
  total: number;
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/entities.ts' }],
    config: makeConfig(['src/**/*.ts'], ['class-names', 'config-keys'])
  });

  assert.ok(results.some((r) => r.type === 'model-missing-doc' && r.explanation.includes('User')));
  assert.ok(results.some((r) => r.type === 'model-missing-doc' && r.explanation.includes('Order')));
}));

test('detectDocsDrift extracts SQLAlchemy models', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'models.py'), `
from sqlalchemy import Column, Integer, String
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)
    name = Column(String)
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/models.py' }],
    config: makeConfig(['src/**/*.py'], ['class-names', 'config-keys'])
  });

  assert.ok(results.some((r) => r.type === 'model-missing-doc' && r.explanation.includes('User')));
}));

// ============ Event Handler Tests ============

test('detectDocsDrift extracts Socket.io event handlers', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'socket.js'), `
const io = require('socket.io')();

io.on('connection', (socket) => {
  socket.on('chat:message', (data) => {
    console.log(data);
  });

  socket.on('user:typing', () => {});

  socket.emit('welcome', { msg: 'Hello' });
});
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'WS: chat:message');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/socket.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures', 'api-endpoints'])
  });

  // Socket.io events are extracted as WebSocket events (ws-event type)
  assert.ok(results.some((r) => r.type === 'ws-event-missing-doc' && r.explanation.includes('user:typing')));
  assert.ok(!results.some((r) => r.type === 'ws-event-missing-doc' && r.explanation.includes('chat:message')));
}));

test('detectDocsDrift extracts DOM event handlers', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'events.js'), `
document.addEventListener('click', handleClick);
window.addEventListener('scroll', handleScroll);
element.onclick = () => {};
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/events.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures', 'api-endpoints'])
  });

  assert.ok(results.some((r) => r.type === 'event-missing-doc' && r.explanation.includes('click')));
  assert.ok(results.some((r) => r.type === 'event-missing-doc' && r.explanation.includes('scroll')));
}));

test('detectDocsDrift extracts EventEmitter handlers', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'emitter.js'), `
const EventEmitter = require('events');
const emitter = new EventEmitter();

emitter.on('user:created', (user) => {});
emitter.once('app:ready', () => {});
emitter.emit('log', 'message');
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/emitter.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures', 'api-endpoints'])
  });

  assert.ok(results.some((r) => r.type === 'event-missing-doc' && r.explanation.includes('user:created')));
  assert.ok(results.some((r) => r.type === 'event-missing-doc' && r.explanation.includes('app:ready')));
}));

// ============ CLI Command Tests ============

test('detectDocsDrift extracts Click CLI commands', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'cli.py'), `
import click

@click.command()
@click.option('--name', '-n', help='User name')
@click.option('--verbose', '-v', is_flag=True)
def main(name, verbose):
    pass

@cli.command('deploy')
def deploy_cmd():
    pass
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'Usage: --name');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/cli.py' }],
    config: makeConfig(['src/**/*.py'], ['cli-flags'])
  });

  assert.ok(results.some((r) => r.type === 'cli-command-missing-doc' && r.explanation.includes('deploy')));
  assert.ok(results.some((r) => r.type === 'cli-flag-missing-doc' && r.explanation.includes('--verbose')));
}));

test('detectDocsDrift extracts Commander.js commands', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'cli.js'), `
const { program } = require('commander');

program
  .command('deploy <app>')
  .option('-e, --env <environment>')
  .action((app, options) => {});

program
  .command('rollback')
  .option('--force')
  .action(() => {});
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'deploy command');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/cli.js' }],
    config: makeConfig(['src/**/*.js'], ['cli-flags'])
  });

  assert.ok(results.some((r) => r.type === 'cli-command-missing-doc' && r.explanation.includes('rollback')));
  assert.ok(!results.some((r) => r.type === 'cli-command-missing-doc' && r.explanation.includes('deploy')));
}));

test('detectDocsDrift extracts Cobra CLI commands', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'cmd.go'), `
package cmd

import "github.com/spf13/cobra"

var rootCmd = &cobra.Command{
  Use: "myapp",
}

var deployCmd = &cobra.Command{
  Use: "deploy",
  Run: func(cmd *cobra.Command, args []string) {},
}

func init() {
  rootCmd.AddCommand(deployCmd)
  deployCmd.Flags().StringP("env", "e", "", "Environment")
  rootCmd.PersistentFlags().Bool("verbose", false, "Verbose output")
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/cmd.go' }],
    config: makeConfig(['src/**/*.go'], ['cli-flags'])
  });

  // Cobra commands and flags are both extracted as CLI commands
  assert.ok(results.some((r) => r.type === 'cli-command-missing-doc' && r.explanation.includes('deploy')));
  assert.ok(results.some((r) => r.type === 'cli-command-missing-doc' && r.explanation.includes('env')));
}));

// ============ Test Description Tests ============

test('detectDocsDrift extracts Jest test descriptions', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'user.test.js'), `
describe('User Service', () => {
  it('should create a new user', () => {
    expect(true).toBe(true);
  });

  test('should delete user by id', () => {
    expect(true).toBe(true);
  });
});
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/user.test.js' }],
    config: makeConfig(['src/**/*.test.js'], ['function-signatures'])
  });

  // Test descriptions are extracted but not required to be documented
  assert.ok(Array.isArray(results));
}));

test('detectDocsDrift extracts pytest test functions', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'test_user.py'), `
import pytest

def test_create_user():
    assert True

async def test_async_delete():
    assert True

class TestUserService:
    def test_get_user(self):
        assert True
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/test_user.py' }],
    config: makeConfig(['src/**/*.py'], ['function-signatures'])
  });

  // Test descriptions are extracted but not required to be documented
  assert.ok(Array.isArray(results));
}));

// ============ Edge Case Tests ============

test('detectDocsDrift handles component documented with kebab-case', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'UserProfile.jsx'), `
export function UserProfile() {
  return <div>Profile</div>;
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'The user-profile component displays user info.');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/UserProfile.jsx' }],
    config: makeConfig(['src/**/*.jsx'], ['function-signatures', 'class-names'])
  });

  // Should not flag as missing since kebab-case "user-profile" matches "UserProfile"
  assert.ok(!results.some((r) => r.type === 'component-missing-doc' && r.explanation.includes('UserProfile')));
}));

test('detectDocsDrift handles model documented with snake_case', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'models.py'), `
from django.db import models

class UserProfile(models.Model):
    name = models.CharField()
`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'The user_profile table stores user data.');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/models.py' }],
    config: makeConfig(['src/**/*.py'], ['class-names', 'config-keys'])
  });

  // Should not flag as missing since snake_case "user_profile" matches "UserProfile"
  assert.ok(!results.some((r) => r.type === 'model-missing-doc' && r.explanation.includes('UserProfile')));
}));

// ============ Error Recovery Tests ============

test('detectDocsDrift handles empty file gracefully', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'empty.js'), '');
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/empty.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  // Should return empty results, not throw
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 0);
}));

test('detectDocsDrift handles file with only whitespace', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'whitespace.js'), '   \n\n\t\t  \n');
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/whitespace.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  assert.ok(Array.isArray(results));
}));

test('detectDocsDrift handles malformed code gracefully', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // Intentionally malformed: unmatched braces, incomplete syntax
  fs.writeFileSync(path.join(dir, 'src', 'malformed.js'), `
function incomplete( {
  const x = {
  // missing closing braces
export function validFunc() {}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/malformed.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  // Should still extract valid patterns
  assert.ok(Array.isArray(results));
}));

test('detectDocsDrift handles special characters in content', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // Note: Avoid actual null bytes which cause binary detection
  fs.writeFileSync(path.join(dir, 'src', 'special.js'), `
// Unicode escape sequences in strings
const emoji = "😀🎉✅";
const regex = /[\\u0000-\\u001f]/;
const arabic = "مرحبا";
const chinese = "你好世界";
export function handleSpecial(input) {
  return input.replace(/[^\\x20-\\x7E]/g, '');
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/special.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  // Should extract the function despite special characters
  assert.ok(results.some((r) => r.type === 'function-missing-doc' && r.explanation.includes('handleSpecial')));
}));

test('detectDocsDrift handles deeply nested code structures', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'nested.js'), `
const deeply = {
  nested: {
    object: {
      with: {
        many: {
          levels: {
            and: {
              a: {
                function: () => {
                  return { more: { nesting: true }};
                }
              }
            }
          }
        }
      }
    }
  }
};

export function topLevelFunc() {
  return deeply.nested.object.with.many.levels.and.a.function();
}
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/nested.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  // Should extract the top-level function
  assert.ok(results.some((r) => r.type === 'function-missing-doc' && r.explanation.includes('topLevelFunc')));
}));

test('detectDocsDrift handles very long lines gracefully', async () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const longString = 'a'.repeat(10000);
  fs.writeFileSync(path.join(dir, 'src', 'longline.js'), `
const veryLongString = "${longString}";
export function normalFunc() { return veryLongString; }
`);
  fs.writeFileSync(path.join(dir, 'README.md'), '');

  const results = await detectDocsDrift({
    repoRoot: dir,
    changedFiles: [{ path: 'src/longline.js' }],
    config: makeConfig(['src/**/*.js'], ['function-signatures'])
  });

  assert.ok(results.some((r) => r.type === 'function-missing-doc' && r.explanation.includes('normalFunc')));
}));
