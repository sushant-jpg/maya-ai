import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createLearningStore } from '../server/learning.js';

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maya-learning-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, 'learning.json') };
}

function createTestApp(learningService, overrides = {}) {
  const local = {
    id: 'lm-studio',
    name: 'LM Studio',
    local: true,
    configured: true,
    defaultModel: 'local-model',
    listModels: async () => ['local-model'],
    streamChat: async () => ({}),
    ...overrides.local,
  };
  const cloud = {
    id: 'deepseek',
    name: 'DeepSeek',
    local: false,
    configured: true,
    defaultModel: '',
    listModels: async () => ['cloud-model'],
    streamChat: async () => ({}),
    ...overrides.cloud,
  };
  return createApp({
    providers: { 'lm-studio': local, deepseek: cloud },
    defaultProvider: 'lm-studio',
    localProviderName: 'LM Studio',
    defaultModel: 'local-model',
    learningService,
  });
}

test('explicit memories support CRUD, relevance retrieval, and persistence across store instances', async (t) => {
  const { filePath } = await temporaryStore(t);
  const store = createLearningStore({ filePath });
  const created = await store.createMemory({
    title: 'Preferred database',
    content: 'Use PostgreSQL for Maya examples.',
  });
  assert.equal(created.approvedByUser, true);
  assert.equal((await store.retrieveMemories('Which database should Maya use?'))[0].id, created.id);

  const restartedStore = createLearningStore({ filePath });
  assert.equal((await restartedStore.listMemories())[0].content, 'Use PostgreSQL for Maya examples.');
  const updated = await restartedStore.updateMemory(created.id, {
    title: 'Database preference',
    content: 'Use SQLite for simple local examples.',
  });
  assert.equal(updated.title, 'Database preference');
  assert.equal(await restartedStore.retrieveMemories('Which database?').then((items) => items[0].content), 'Use SQLite for simple local examples.');
  assert.equal(await restartedStore.deleteMemory(created.id), true);
  assert.deepEqual(await restartedStore.listMemories(), []);
});

test('memory and feedback validation rejects secrets and malformed IDs', async (t) => {
  const { filePath } = await temporaryStore(t);
  const store = createLearningStore({ filePath });
  await assert.rejects(store.createMemory({ title: 'API setup', content: 'api_key=supersecretvalue123' }), {
    code: 'SENSITIVE_CONTENT_REJECTED',
  });
  await assert.rejects(store.updateMemory('not-an-id', { title: 'Title', content: 'Content' }), {
    code: 'INVALID_LEARNING_INPUT',
  });
  await assert.rejects(store.recordFeedback({
    messageId: 'not-an-id',
    conversationId: 'not-an-id',
    rating: 'positive',
    provider: 'lm-studio',
    model: 'local-model',
  }), { code: 'INVALID_LEARNING_INPUT' });
});

test('memory and feedback APIs require explicit user actions and never send memories to cloud', async (t) => {
  const { filePath } = await temporaryStore(t);
  const learningService = createLearningStore({ filePath });
  let localRequest;
  let cloudRequest;
  const app = createTestApp(learningService, {
    local: {
      streamChat: async (options) => {
        localRequest = options;
        options.onToken('local answer');
      },
    },
    cloud: {
      streamChat: async (options) => {
        cloudRequest = options;
        options.onToken('cloud answer');
      },
    },
  });

  await request(app).post('/api/memories')
    .send({ title: 'API setup', content: 'api_key=supersecretvalue123' })
    .expect(422)
    .expect(({ body }) => assert.equal(body.code, 'SENSITIVE_CONTENT_REJECTED'));
  const created = await request(app).post('/api/memories')
    .send({ title: 'Preferred database', content: 'Use PostgreSQL for Maya examples.' })
    .expect(201);
  assert.equal(created.body.memory.approvedByUser, true);
  await request(app).post('/api/chat').send({
    provider: 'lm-studio',
    model: 'local-model',
    message: 'What database should Maya use?',
  }).expect(200);
  assert.doesNotMatch(localRequest.systemPrompt, /User-approved memories|PostgreSQL/);
  await request(app).post('/api/chat').send({
    provider: 'lm-studio',
    model: 'local-model',
    message: 'What database should Maya use?',
    useMemory: true,
  }).expect(200);
  assert.match(localRequest.systemPrompt, /User-approved memories/);
  assert.match(localRequest.systemPrompt, /Use PostgreSQL/);

  const cloudResponse = await request(app).post('/api/chat').send({
    provider: 'deepseek',
    model: 'cloud-model',
    message: 'What database should Maya use?',
    useMemory: true,
  }).expect(200);
  assert.doesNotMatch(cloudRequest.systemPrompt, /PostgreSQL|User-approved memories/);
  assert.match(cloudResponse.text, /private documents and local project notes are not sent to cloud models/);
  assert.equal((await request(app).get('/api/memories').expect(200)).body.memories.length, 1);
  assert.equal((await request(app).get('/api/memories?q=database').expect(200)).body.memories.length, 1);

  const feedback = {
    messageId: '3d6c6d18-31c9-4cf5-b0a2-62d3d9b71571',
    conversationId: 'e04d2ed8-b996-48a5-b017-73ca4ca30f48',
    rating: 'positive',
    provider: 'lm-studio',
    model: 'local-model',
  };
  await request(app).post('/api/feedback').send(feedback).expect(201);
  await request(app).post('/api/feedback').send({ ...feedback, rating: 'negative' }).expect(201);
  const savedFeedback = (await request(app).get('/api/feedback').expect(200)).body.feedback;
  assert.equal(savedFeedback.length, 1);
  assert.equal(savedFeedback[0].rating, 'negative');
  assert.equal(Object.hasOwn(savedFeedback[0], 'content'), false);
  await request(app).delete(`/api/feedback/${feedback.messageId}`).expect(200);
  assert.equal((await request(app).get('/api/feedback').expect(200)).body.feedback.length, 0);

  await request(app).put(`/api/memories/${created.body.memory.id}`)
    .send({ title: 'Updated preference', content: 'Use SQLite.' }).expect(200);
  await request(app).delete(`/api/memories/${created.body.memory.id}`).expect(200);
});

test('corrupt persisted learning data is reported without replacing it', async (t) => {
  const { filePath } = await temporaryStore(t);
  const original = '{invalid';
  await fs.writeFile(filePath, original, 'utf8');
  const store = createLearningStore({ filePath });
  await assert.rejects(store.createMemory({ title: 'Title', content: 'Content' }), {
    code: 'LEARNING_STORE_CORRUPT',
  });
  assert.equal(await fs.readFile(filePath, 'utf8'), original);
});
