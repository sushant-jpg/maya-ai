import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createWorkspaceService, WorkspaceError } from '../server/workspace.js';

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maya-workspace-'));
  temporaryRoots.push(root);
  return root;
}

test('workspace service is disabled unless an explicit root is configured', async () => {
  const workspace = createWorkspaceService();
  assert.deepEqual(await workspace.getInfo(), { enabled: false });
  await assert.rejects(workspace.listFiles(), (error) => error instanceof WorkspaceError && error.status === 503);
});

test('workspace listing and reading stay within root and hide credentials and build directories', async () => {
  const root = await createWorkspace();
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, '.aws'));
  await fs.writeFile(path.join(root, 'src', 'main.ts'), 'const marker = "safe";\n');
  await fs.writeFile(path.join(root, '.env.local'), 'SECRET=private\n');
  await fs.writeFile(path.join(root, 'credentials.json'), '{}');
  await fs.writeFile(path.join(root, '.aws', 'credentials'), 'aws_secret_access_key=private\n');
  const workspace = createWorkspaceService({ rootPath: root });

  const listing = await workspace.listFiles();
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['src']);
  assert.equal((await workspace.readFile('src/main.ts')).content, 'const marker = "safe";\n');
  await assert.rejects(workspace.readFile('../outside.txt'), /traversal/);
  await assert.rejects(workspace.readFile('src/main.ts:secret'), /unsupported file-system names/);
  await assert.rejects(workspace.readFile('NUL'), /unsupported file-system names/);
  await assert.rejects(workspace.readFile('.env.local'), /protected/);
  await assert.rejects(workspace.readFile('credentials.json'), /protected/);
  await assert.rejects(workspace.readFile('.aws/credentials'), /protected/);
  await assert.rejects(workspace.readFile(path.join(root, 'src', 'main.ts')), /relative/);
});

test('workspace tools refuse symbolic links', async (context) => {
  const root = await createWorkspace();
  const outside = await createWorkspace();
  await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  try {
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      context.skip('Creating symbolic links is not permitted in this Windows environment.');
      return;
    }
    throw error;
  }
  const workspace = createWorkspaceService({ rootPath: root });
  await assert.rejects(workspace.readFile('linked/private.txt'), /Symbolic links/);
  assert.equal((await workspace.listFiles()).entries.some((entry) => entry.name === 'linked'), false);
});

test('workspace code search returns bounded text matches and omits protected files', async () => {
  const root = await createWorkspace();
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const SafeValue = 1;\n');
  await fs.writeFile(path.join(root, '.env'), 'SafeValue=secret\n');
  const workspace = createWorkspaceService({ rootPath: root });

  const result = await workspace.searchCode('SafeValue');
  assert.deepEqual(result.matches, [{ path: 'src/app.ts', line: 1, text: 'export const SafeValue = 1;' }]);
  assert.equal(result.truncated, false);
});

test('file proposals require a current file version and apply only after explicit approval', async () => {
  const root = await createWorkspace();
  const file = path.join(root, 'new.ts');
  const workspace = createWorkspaceService({ rootPath: root });
  const proposal = await workspace.createProposal('new.ts', 'export const value = 1;\n');
  assert.equal(await fs.access(file).then(() => true, () => false), false);
  assert.deepEqual(await workspace.applyProposal(proposal.id), { applied: true, path: 'new.ts' });
  assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 1;\n');

  const update = await workspace.createProposal('new.ts', 'export const value = 2;\n');
  assert.deepEqual(await workspace.applyProposal(update.id), { applied: true, path: 'new.ts' });
  assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 2;\n');

  const stale = await workspace.createProposal('new.ts', 'export const value = 2;\n');
  await fs.writeFile(file, 'export const value = 3;\n');
  await assert.rejects(workspace.applyProposal(stale.id), (error) => error instanceof WorkspaceError && error.status === 409);
  assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 3;\n');
  await assert.rejects(workspace.createProposal('unicode.txt', '🔒'.repeat(200_000)), /512 KB/);
});

test('workspace checks require approval and run only fixed npm script names', async () => {
  const root = await createWorkspace();
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo test' } }));
  const calls = [];
  const workspace = createWorkspaceService({
    rootPath: root,
    spawnProcess(command, args, options) {
      calls.push({ command, args, env: options.env });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('tests passed\nAPI_AUTH_TOKEN=do-not-show\nAuthorization: Bearer abc123\n'));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  await assert.rejects(workspace.runCheck('test', false), /Explicit approval/);
  await assert.rejects(workspace.runCheck('install', true), /Only test, lint, typecheck, and build/);
  const previousToken = process.env.API_AUTH_TOKEN;
  process.env.API_AUTH_TOKEN = 'must-not-reach-project-scripts';
  let result;
  try {
    result = await workspace.runCheck('test', true);
  } finally {
    if (previousToken === undefined) delete process.env.API_AUTH_TOKEN;
    else process.env.API_AUTH_TOKEN = previousToken;
  }
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'tests passed\nAPI_AUTH_TOKEN=[REDACTED]\nAuthorization: [REDACTED]\n');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd run test']
    : ['run', 'test']);
  assert.equal(calls[0].env.API_AUTH_TOKEN, undefined);
  assert.ok(calls[0].env.PATH || calls[0].env.Path);
});

test('workspace API requires approval before writes and approved checks', async () => {
  const root = await createWorkspace();
  const app = createApp({
    ollama: { listModels: async () => [], streamChat: async () => {} },
    workspaceService: createWorkspaceService({ rootPath: root }),
  });
  const proposal = await request(app).post('/api/workspace/proposals')
    .send({ path: 'created.md', content: '# Draft\n' }).expect(201);
  await request(app).post(`/api/workspace/proposals/${proposal.body.proposal.id}/apply`)
    .send({ approved: false }).expect(403);
  await request(app).post('/api/workspace/checks').send({ check: 'install', approved: true }).expect(400);
  await request(app).post('/api/workspace/proposals/not-a-uuid/apply')
    .send({ approved: true }).expect(400);
  const read = await request(app).get('/api/workspace').expect(200);
  assert.equal(read.body.workspace.enabled, true);
  assert.equal(JSON.stringify(read.body).includes(root), false);
});

test('workspace APIs report disabled state and deny file operations when no root is configured', async () => {
  const app = createApp({ ollama: { listModels: async () => [], streamChat: async () => {} } });
  await request(app).get('/api/workspace').expect(200).expect({ workspace: { enabled: false } });
  await request(app).get('/api/workspace/files').expect(503)
    .expect(({ body }) => assert.match(body.error, /not configured/));
});

test('workspace APIs remain protected by API token authentication when enabled', async () => {
  const token = 'w'.repeat(40);
  const root = await createWorkspace();
  const app = createApp({
    ollama: { listModels: async () => [], streamChat: async () => {} },
    workspaceService: createWorkspaceService({ rootPath: root }),
    authToken: token,
  });
  await request(app).get('/api/workspace').expect(401);
  await request(app).get('/api/workspace').set('Authorization', `Bearer ${token}`).expect(200);
});
