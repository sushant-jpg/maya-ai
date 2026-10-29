import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, test } from 'node:test';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { OllamaError } from '../server/ollama.js';
import { ChromaStorageError, createRagService, DocumentProcessingError, parseChromaUrl } from '../server/rag.js';
import { createSearchProvider } from '../server/search.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

test('API token authentication protects routes and permits CORS preflight', async () => {
  const token = 'a'.repeat(40);
  const app = createApp({
    ollama: { listModels: async () => ['qwen3:4b'], streamChat: async () => {} },
    authToken: token,
  });
  await request(app).get('/api/models').expect(401);
  await request(app).get('/api/models').set('Authorization', 'Bearer wrong').expect(401);
  const authorized = await request(app).get('/api/models').set('Authorization', `Bearer ${token}`).expect(200);
  assert.equal(authorized.headers['x-content-type-options'], 'nosniff');
  assert.equal(authorized.headers['x-frame-options'], 'DENY');
  await request(app).options('/api/chat').expect(204);
  assert.throws(() => createApp({ ollama: {}, authToken: 'short' }), /at least 32 characters/);
});

test('chat requests are rate limited before local inference', async () => {
  let generationCalls = 0;
  const app = createTestApp({
    streamChat: async ({ onToken }) => {
      generationCalls += 1;
      onToken('ok');
    },
  });
  for (let index = 0; index < 20; index += 1) {
    await request(app).post('/api/chat').send({ message: 'hello' }).expect(200);
  }
  await request(app).post('/api/chat').send({ message: 'hello' }).expect(429);
  assert.equal(generationCalls, 20);
});

function createTestApp(overrides = {}, rag, searchProvider) {
  const ollama = {
    listModels: async () => ['qwen3:4b'],
    streamChat: async ({ onToken }) => {
      onToken('```html\n<h1>Hello</h1>\n```');
    },
    ...overrides,
  };
  return createApp({ ollama, rag, searchProvider, defaultModel: 'qwen3:4b' });
}

function createFakeVectorStore() {
  const records = new Map();
  const matchesWhere = (record, where) => !where || Object.entries(where).every(([key, value]) => record.metadata[key] === value);
  const collection = {
    add: async ({ ids, documents, metadatas }) => ids.forEach((id, index) => records.set(id, {
      document: documents[index],
      metadata: metadatas[index],
    })),
    count: async () => records.size,
    get: async ({ where } = {}) => {
      const entries = [...records.entries()].filter(([, record]) => matchesWhere(record, where));
      return {
        ids: entries.map(([id]) => id),
        metadatas: entries.map(([, record]) => record.metadata),
      };
    },
    query: async ({ where, nResults }) => {
      const entries = [...records.entries()].filter(([, record]) => matchesWhere(record, where)).slice(0, nResults);
      return {
        documents: [entries.map(([, record]) => record.document)],
        metadatas: [entries.map(([, record]) => record.metadata)],
        distances: [entries.map(() => 0.1)],
      };
    },
    delete: async ({ ids }) => ids.forEach((id) => records.delete(id)),
  };
  return { client: { getOrCreateCollection: async () => collection }, records };
}

describe('Maya API', () => {
  test('GET /api/documents/health reports Chroma health without requiring a collection', async () => {
    let collectionCreated = false;
    const rag = {
      checkStorage: async () => ({ ok: true, status: 'ready', url: 'http://127.0.0.1:8000', collectionCount: 2 }),
      getOrCreateCollection: async () => { collectionCreated = true; },
    };
    const response = await request(createTestApp({}, rag)).get('/api/documents/health').expect(200);
    assert.deepEqual(response.body, {
      ok: true,
      status: 'ready',
      url: 'http://127.0.0.1:8000',
      collectionCount: 2,
    });
    assert.equal(collectionCreated, false);
  });

  test('GET /api/documents/health gives a useful Chroma connection failure', async () => {
    const rag = {
      checkStorage: async () => ({
        ok: false,
        status: 'unavailable',
        code: 'CHROMA_UNAVAILABLE',
        error: 'ChromaDB is not reachable at http://127.0.0.1:8000. Start Docker Desktop, then run "docker compose up -d chroma" from the project directory.',
      }),
    };
    const response = await request(createTestApp({}, rag)).get('/api/documents/health').expect(503);
    assert.equal(response.body.code, 'CHROMA_UNAVAILABLE');
    assert.match(response.body.error, /docker compose up -d chroma/);
  });

  test('document list route surfaces a diagnosed Chroma storage failure', async () => {
    const rag = {
      listDocuments: async () => {
        throw new ChromaStorageError('CHROMA_UNAVAILABLE', 'ChromaDB is not reachable at http://127.0.0.1:8000.', 'unavailable');
      },
    };
    const response = await request(createTestApp({}, rag)).get('/api/documents').expect(503);
    assert.equal(response.body.code, 'CHROMA_UNAVAILABLE');
    assert.match(response.body.error, /127\.0\.0\.1:8000/);
  });

  test('GET /api/health reports Ollama and model status', async () => {
    const response = await request(createTestApp()).get('/api/health').expect(200);
    assert.deepEqual(response.body, { ok: true, ollama: 'connected', status: 'ready', model: 'qwen3:4b', models: ['qwen3:4b'] });
  });

  test('GET /api/models lists local models', async () => {
    const response = await request(createTestApp()).get('/api/models').expect(200);
    assert.deepEqual(response.body, { models: ['qwen3:4b'], defaultModel: 'qwen3:4b' });
  });

  test('GET /api/providers exposes only local Ollama inference', async () => {
    const app = createTestApp();
    const response = await request(app).get('/api/providers').expect(200);
    assert.deepEqual(response.body, {
      providers: [{
        id: 'local',
        name: 'Ollama',
        configured: true,
        defaultModel: 'qwen3:4b',
      }],
      defaultProvider: 'local',
      authRequired: false,
    });
    assert.equal(JSON.stringify(response.body).includes('API_KEY'), false);
  });

  test('chat requests reject cloud execution without falling back to Ollama', async () => {
    let localCalls = 0;
    const app = createTestApp({
      streamChat: async () => { localCalls += 1; },
    });

    await request(app).post('/api/chat').send({ message: 'Hello', provider: 'cloud' }).expect(400)
      .expect(({ body }) => assert.match(body.error, /Unknown provider/));
    assert.equal(localCalls, 0);
  });

  test('chat emits local provider and generation metrics after successful completion', async () => {
    const app = createTestApp({
      streamChat: async ({ model, onToken }) => {
        assert.equal(model, 'qwen3:4b');
        onToken('local result');
        return { firstTokenMs: 4, totalMs: 9, inputTokens: 12, outputTokens: 3 };
      },
    });
    const response = await request(app).post('/api/chat')
      .send({ message: 'Hello' })
      .expect(200);
    assert.match(response.text, /"token":"local result"/);
    assert.match(response.text, /"metrics":\{"provider":"local","model":"qwen3:4b","firstTokenMs":4,"totalMs":9,"inputTokens":12,"outputTokens":3\}/);
    assert.match(response.text, /"done":true/);
  });

  test('health and models return useful errors when Ollama is unavailable', async () => {
    const app = createTestApp({ listModels: async () => { throw new Error('offline'); } });
    await request(app).get('/api/health').expect(503).expect(({ body }) => assert.match(body.error, /Ollama is unreachable/));
    await request(app).get('/api/models').expect(503).expect(({ body }) => assert.match(body.error, /Ollama is unreachable/));
  });

  test('health maps Ollama timeouts safely without returning internal error details', async () => {
    const app = createTestApp({
      listModels: async () => { throw new OllamaError('TIMEOUT', 'private internal detail'); },
    });
    await request(app).get('/api/health').expect(504).expect(({ body }) => {
      assert.equal(body.status, 'timeout');
      assert.equal(body.code, 'TIMEOUT');
      assert.match(body.error, /OLLAMA_TIMEOUT_MS/);
      assert.doesNotMatch(JSON.stringify(body), /private internal detail/);
    });
  });

  test('health reports when the configured model is missing', async () => {
    const app = createTestApp({ listModels: async () => [] });
    await request(app).get('/api/health').expect(503).expect(({ body }) => {
      assert.equal(body.ollama, 'connected');
      assert.match(body.error, /ollama pull qwen3:4b/);
    });
  });

  test('allows a configured frontend CORS origin and handles preflight', async () => {
    const app = createApp({ ollama: { listModels: async () => [], streamChat: async () => {} }, corsOrigins: 'https://maya.example.test' });
    const response = await request(app).options('/api/chat').set('Origin', 'https://maya.example.test').expect(204);
    assert.equal(response.headers['access-control-allow-origin'], 'https://maya.example.test');
    await request(app).options('/api/chat').set('Origin', 'https://evil.example').expect(403);
    await request(app).get('/api/models').set('Origin', 'https://evil.example').expect(403);
  });

  test('allows the local Next.js origin with default CORS settings', async () => {
    const response = await request(createTestApp())
      .get('/api/models')
      .set('Origin', 'http://127.0.0.1:3001')
      .expect(200);
    assert.equal(response.headers['access-control-allow-origin'], 'http://127.0.0.1:3001');
  });

  test('chat rejects invalid requests', async () => {
    await request(createTestApp()).post('/api/chat').send({}).expect(400).expect(({ body }) => assert.match(body.error, /non-empty message/));
    await request(createTestApp()).post('/api/chat').send({ message: 'hello', conversation: [{ role: 'system', content: 'bad' }] }).expect(400);
  });

  test('chat returns buffered SSE tokens and done event', async () => {
    const response = await request(createTestApp()).post('/api/chat').send({ message: 'Make a simple HTML webpage', context: 99999, maxTokens: 99999 }).expect(200);
    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.match(response.text, /data: \{"token":"```html\\n<h1>Hello<\/h1>\\n```"\}/);
  });

  test('chat forwards system instructions and clamps resource settings', async () => {
    let received;
    const app = createTestApp({
      streamChat: async (options) => {
        received = options;
        options.onToken('ok');
      },
    });
    await request(app).post('/api/chat').send({
      message: 'hello',
      systemPrompt: 'Use concise answers',
      temperature: 2,
      context: 99999,
      maxTokens: 99999,
    }).expect(200);
    assert.equal(received.systemPrompt, 'Use concise answers');
    assert.equal(received.temperature, 1);
    assert.equal(received.context, 4096);
    assert.equal(received.maxTokens, 4096);
  });

  test('chat reports token-limited output as potentially incomplete', async () => {
    const app = createTestApp({
      streamChat: async ({ onToken }) => {
        onToken('partial code');
        return { finishReason: 'length', outputTokens: 2048 };
      },
    });
    const response = await request(app).post('/api/chat').send({ message: 'Generate a login page' }).expect(200);
    assert.match(response.text, /"finishReason":"length"/);
    assert.match(response.text, /response may be incomplete/);
  });

  test('chat rejects invalid model names and oversized instructions', async () => {
    await request(createTestApp()).post('/api/chat').send({ message: 'hello', model: 'bad model' }).expect(400);
    await request(createTestApp()).post('/api/chat').send({ message: 'hello', systemPrompt: 'x'.repeat(4001) }).expect(400);
    await request(createTestApp()).post('/api/chat').send({ message: 'x'.repeat(32001) }).expect(413);
  });

  test('document endpoints validate uploads, list documents, and delete by id', async () => {
    const stored = { id: '550e8400-e29b-41d4-a716-446655440000', name: 'notes.txt', chunks: 2 };
    const rag = {
      listDocuments: async () => [stored],
      ingestDocument: async (file) => ({ ...stored, name: file.originalname }),
      deleteDocument: async (id) => id === stored.id,
    };
    const app = createTestApp({}, rag);
    await request(app).get('/api/documents').expect(200).expect(({ body }) => assert.equal(body.documents[0].name, 'notes.txt'));
    await request(app).post('/api/documents').attach('file', Buffer.from('local notes'), 'notes.txt').expect(201);
    await request(app).post('/api/documents').attach('file', Buffer.from('no'), 'notes.exe').expect(415);
    await request(app).delete('/api/documents/not-an-id').expect(400);
    await request(app).delete(`/api/documents/${stored.id}`).expect(200).expect(({ body }) => assert.equal(body.deleted, true));
    await request(createTestApp()).get('/api/documents').expect(503);
  });

  test('chat retrieves private excerpts before generation and emits source metadata', async () => {
    let receivedSources;
    const rag = {
      retrieve: async () => [{
        documentId: 'doc-1',
        fileName: 'notes.md',
        chunkIndex: 2,
        content: 'The local answer is 42.',
      }],
    };
    const app = createTestApp({
      streamChat: async ({ sources, onToken }) => {
        receivedSources = sources;
        onToken('42');
      },
    }, rag);
    const response = await request(app).post('/api/chat').send({ message: 'What is the local answer?' }).expect(200);
    assert.equal(receivedSources[0].content, 'The local answer is 42.');
    assert.match(response.text, /"sources":\[\{"kind":"document","documentId":"doc-1","fileName":"notes.md","chunkIndex":2\}\]/);
  });

  test('web search runs only when requested and returns verifiable source links', async () => {
    let searchCalls = 0;
    const searchProvider = {
      enabled: true,
      search: async () => {
        searchCalls += 1;
        return [{ kind: 'web', title: 'Source title', url: 'https://example.com/source', date: '2 days ago', content: 'Evidence snippet' }];
      },
    };
    const app = createTestApp({}, null, searchProvider);
    await request(app).post('/api/chat').send({ message: 'hello' }).expect(200);
    assert.equal(searchCalls, 0);
    const response = await request(app).post('/api/chat').send({ message: 'Find recent information', webSearch: true }).expect(200);
    assert.equal(searchCalls, 1);
    assert.match(response.text, /"kind":"web","title":"Source title","url":"https:\/\/example.com\/source"/);
    await request(app).post('/api/chat').send({ message: 'hello', webSearch: 'true' }).expect(400);
  });

  test('Brave provider is optional and sanitizes search results to HTTPS sources', async () => {
    const disabled = createSearchProvider({ providerName: 'none', fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(disabled.enabled, false);
    assert.deepEqual(await disabled.search('query'), []);

    let requestedUrl;
    const provider = createSearchProvider({
      providerName: 'brave',
      apiKey: 'test-key',
      fetchImpl: async (url, options) => {
        requestedUrl = { url: String(url), options };
        return new Response(JSON.stringify({
          web: {
            results: [
              { title: 'Safe source', url: 'https://example.com', description: 'Snippet', page_age: 'today' },
              { title: 'Unsafe', url: 'javascript:alert(1)', description: 'No' },
            ],
          },
        }), { status: 200 });
      },
    });
    const results = await provider.search('latest update');
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://example.com/');
    assert.match(requestedUrl.url, /q=latest\+update/);
    assert.equal(requestedUrl.options.headers['X-Subscription-Token'], 'test-key');
  });

  test('local RAG chunks, retrieves, lists, and deletes document embeddings', async () => {
    const { client, records } = createFakeVectorStore();
    const rag = createRagService({
      client,
      embedTexts: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
    });
    const file = {
      originalname: '..\\secrets\\notes.txt',
      buffer: Buffer.from('Maya keeps private notes. '.repeat(130)),
    };
    const document = await rag.ingestDocument(file);
    assert.ok(document.chunks > 1);
    assert.equal(document.name, 'notes.txt');
    assert.equal(records.size, document.chunks);
    assert.equal((await rag.listDocuments())[0].id, document.id);
    const matches = await rag.retrieve('private notes');
    assert.ok(matches.length > 0);
    assert.equal(await rag.deleteDocument(document.id), true);
    assert.equal(await rag.deleteDocument(document.id), false);
    assert.equal(await rag.retrieve('private notes').then((items) => items.length), 0);
  });

  test('Chroma health check distinguishes unavailable, incorrect URL, and initialization failures', async () => {
    const cases = [
      {
        client: { heartbeat: async () => { throw Object.assign(new Error('connection refused'), { name: 'ChromaConnectionError' }); } },
        status: 'unavailable',
        code: 'CHROMA_UNAVAILABLE',
      },
      {
        client: { heartbeat: async () => { throw Object.assign(new Error('404'), { name: 'ChromaNotFoundError' }); } },
        status: 'misconfigured',
        code: 'CHROMA_URL_INCORRECT',
      },
      {
        client: { heartbeat: async () => 1, countCollections: async () => { throw new Error('database not initialized'); } },
        status: 'initialization_error',
        code: 'CHROMA_INITIALIZATION_FAILED',
      },
    ];
    for (const { client, status, code } of cases) {
      const rag = createRagService({ client });
      const result = await rag.checkStorage();
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(result.code, code);
    }

    const ready = createRagService({
      client: { heartbeat: async () => 1, countCollections: async () => 3 },
    });
    assert.deepEqual(await ready.checkStorage(), {
      ok: true,
      status: 'ready',
      url: 'http://127.0.0.1:8000',
      collectionCount: 3,
    });
  });

  test('CHROMA_URL accepts local loopback and Compose service URLs and rejects unsafe or unsupported URLs', () => {
    assert.equal(parseChromaUrl('http://127.0.0.1:8000').hostname, '127.0.0.1');
    assert.equal(parseChromaUrl('http://chroma:8000').hostname, 'chroma');
    assert.throws(() => parseChromaUrl('https://chroma.example.com'), /local Chroma server/);
    assert.throws(() => parseChromaUrl('http://127.0.0.1:8000/api/v2'), /local Chroma server/);
    assert.throws(() => parseChromaUrl('http://user:pass@127.0.0.1:8000'), /local Chroma server/);
  });

  test('rejects malformed PDF data before embedding', async () => {
    const { client } = createFakeVectorStore();
    const rag = createRagService({ client, embedTexts: async () => [] });
    await assert.rejects(
      rag.ingestDocument({ originalname: 'bad.pdf', buffer: Buffer.from('not a pdf') }),
      DocumentProcessingError,
    );
  });

  test('chat converts Ollama failures into an SSE error', async () => {
    const app = createTestApp({ streamChat: async () => { throw new Error('model missing'); } });
    const response = await request(app).post('/api/chat').send({ message: 'hello' }).expect(200);
    assert.match(response.text, /Model qwen3:4b is not installed\. Run: ollama pull qwen3:4b/);
  });

  test('client disconnect aborts Ollama generation', async () => {
    let aborted = false;
    const app = createTestApp({
      streamChat: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      }),
    });
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    await new Promise((resolve) => {
      const client = http.request({ port, method: 'POST', path: '/api/chat', headers: { 'Content-Type': 'application/json' } });
      client.on('response', (response) => { response.destroy(); resolve(); });
      client.write(JSON.stringify({ message: 'long response' }));
      client.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aborted, true);
  });
});
