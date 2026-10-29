import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLmStudioClient } from '../server/lm-studio.js';
import { LocalModelError } from '../server/ollama.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function eventStream(events, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}

test('LM Studio configuration only accepts loopback OpenAI-compatible endpoints', () => {
  for (const baseUrl of [
    'https://api.example.test/v1',
    'http://192.168.1.4:1234/v1',
    'http://localhost:1234/v1?token=private',
    'http://user:password@localhost:1234/v1',
    'http://localhost:1234/v1/chat/completions',
    'file:///models',
  ]) {
    assert.throws(() => createLmStudioClient({ baseUrl }), /LM_STUDIO_BASE_URL/);
  }
  assert.throws(() => createLmStudioClient({ timeoutMs: 0 }), /LM_STUDIO_TIMEOUT_MS/);
  assert.doesNotThrow(() => createLmStudioClient({ baseUrl: 'http://127.0.0.1:1234/v1' }));
  assert.doesNotThrow(() => createLmStudioClient({ baseUrl: 'http://[::1]:1234/v1' }));
});

test('model discovery validates the OpenAI-compatible models response', async () => {
  const client = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:1234/v1/models');
      return jsonResponse({ data: [{ id: 'loaded-coder' }, { id: 'vision-model:latest' }, { id: 'second-model' }] });
    },
  });
  assert.deepEqual(await client.listModels(), ['loaded-coder', 'vision-model:latest', 'second-model']);

  const empty = createLmStudioClient({ fetchImpl: async () => jsonResponse({ data: [] }) });
  assert.deepEqual(await empty.listModels(), []);

  const malformed = createLmStudioClient({
    fetchImpl: async () => jsonResponse({ data: [{ name: 'missing-id' }] }),
  });
  await assert.rejects(malformed.listModels(), { code: 'MALFORMED_RESPONSE' });
});

test('LM Studio optional API key is sent only to its configured local endpoint', async () => {
  let captured;
  const client = createLmStudioClient({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'local-test-secret',
    fetchImpl: async (url, options) => {
      captured = { url, authorization: new Headers(options.headers).get('authorization') };
      return jsonResponse({ data: [{ id: 'loaded-coder' }] });
    },
  });
  assert.deepEqual(await client.listModels(), ['loaded-coder']);
  assert.equal(captured.url, 'http://127.0.0.1:1234/v1/models');
  assert.equal(captured.authorization, 'Bearer local-test-secret');

  const rejected = createLmStudioClient({
    apiKey: 'do-not-echo-this',
    fetchImpl: async () => jsonResponse({ error: 'unauthorized' }, 401),
  });
  await assert.rejects(rejected.listModels(), (error) => {
    assert.equal(error.code, 'AUTHENTICATION_FAILED');
    assert.match(error.message, /LM_STUDIO_API_KEY/);
    assert.doesNotMatch(error.message, /do-not-echo-this/);
    return true;
  });
});

test('non-streaming chat uses the LM Studio OpenAI-compatible request and response shape', async () => {
  let captured;
  const client = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'Local answer' } }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      });
    },
  });
  const result = await client.chatCompletion({
    message: 'Explain this function',
    conversation: [{ role: 'user', content: 'Earlier question' }],
    systemPrompt: 'Be concise',
    model: 'loaded-coder',
    maxTokens: 200,
  });

  assert.equal(captured.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(captured.body.model, 'loaded-coder');
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.max_tokens, 200);
  assert.deepEqual(captured.body.messages.map(({ role }) => role), ['system', 'user', 'user']);
  assert.equal(result.content, 'Local answer');
  assert.deepEqual(result.metrics, {
    provider: 'local',
    model: 'loaded-coder',
    firstTokenMs: null,
    totalMs: result.metrics.totalMs,
    inputTokens: 8,
    outputTokens: 3,
  });
});

test('chat rejects model substitution and empty assistant output', async () => {
  const substitutedModel = createLmStudioClient({
    model: 'requested-coder',
    fetchImpl: async () => jsonResponse({
      model: 'another-loaded-model',
      choices: [{ message: { role: 'assistant', content: 'Not the requested model' } }],
    }),
  });
  await assert.rejects(substitutedModel.chatCompletion({ message: 'Hello' }), {
    code: 'MODEL_NOT_LOADED',
  });

  const emptyResponse = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async () => jsonResponse({
      model: 'loaded-coder',
      choices: [{ message: { role: 'assistant', content: '' } }],
    }),
  });
  await assert.rejects(emptyResponse.chatCompletion({ message: 'Hello' }), {
    code: 'GENERATION_FAILED',
  });

  const emptyStream = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async () => eventStream([
      'data: {"model":"loaded-coder","choices":[{"delta":{} }]}\n\n',
      'data: [DONE]\n\n',
    ]),
  });
  await assert.rejects(emptyStream.streamChat({
    message: 'Hello',
    onToken: () => undefined,
  }), { code: 'GENERATION_FAILED' });
});

test('empty reasoning-only responses identify the exhausted output budget without exposing reasoning', async () => {
  const client = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async () => jsonResponse({
      choices: [{
        finish_reason: 'length',
        message: { role: 'assistant', content: '', reasoning_content: 'private chain of thought' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 256, completion_tokens_details: { reasoning_tokens: 256 } },
    }),
  });
  await assert.rejects(client.chatCompletion({ message: 'Generate a login page' }), (error) => {
    assert.equal(error.code, 'GENERATION_FAILED');
    assert.match(error.message, /output budget for internal reasoning/i);
    assert.doesNotMatch(error.message, /private chain of thought/);
    return true;
  });
});

test('reasoning-only streams fail clearly instead of yielding an empty successful answer', async () => {
  const client = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async () => eventStream([
      'data: {"choices":[{"delta":{"reasoning_content":"not visible to user"},"finish_reason":"length"}]}\n\n',
    ]),
  });
  await assert.rejects(client.streamChat({ message: 'Generate code', onToken: () => undefined }), (error) => {
    assert.equal(error.code, 'GENERATION_FAILED');
    assert.match(error.message, /output budget for internal reasoning/i);
    assert.doesNotMatch(error.message, /not visible to user/);
    return true;
  });
});

test('LM Studio accepts text blocks and identifies truncated code responses', async () => {
  const client = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async () => jsonResponse({
      choices: [{
        finish_reason: 'length',
        message: { role: 'assistant', content: [{ type: 'text', text: '<form>' }, { type: 'text', text: '</form>' }] },
      }],
    }),
  });
  const result = await client.chatCompletion({ message: 'Generate complete HTML', maxTokens: 2048 });
  assert.equal(result.content, '<form></form>');
  assert.equal(result.metrics.finishReason, 'length');
});

test('streaming reports a token-limit finish reason and keeps visible partial code explicit', async () => {
  const client = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async () => eventStream([
      'data: {"choices":[{"delta":{"content":"<main>partial"} }]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    ]),
  });
  const tokens = [];
  const metrics = await client.streamChat({
    message: 'Generate a complete HTML login page',
    maxTokens: 2048,
    onToken: (token) => tokens.push(token),
  });
  assert.deepEqual(tokens, ['<main>partial']);
  assert.equal(metrics.finishReason, 'length');
});

test('code-generation prompts retain the selected model, output budget, and complete stream content', async (t) => {
  for (const prompt of [
    'Generate a complete HTML login page.',
    'Write a responsive CSS layout.',
    'Implement JavaScript form validation.',
    'Create a React login component.',
  ]) {
    await t.test(prompt, async () => {
      const generated = `// ${prompt}\n${'const result = true;\n'.repeat(30)}`;
      let requestBody;
      const client = createLmStudioClient({
        model: 'local-coder',
        fetchImpl: async (_url, options) => {
          requestBody = JSON.parse(options.body);
          const events = [
            `data: ${JSON.stringify({ model: 'local-coder', choices: [{ delta: { content: generated }, finish_reason: 'stop' }] })}\n\n`,
          ];
          return eventStream(events);
        },
      });
      let content = '';
      const metrics = await client.streamChat({
        message: prompt,
        model: 'local-coder',
        maxTokens: 2048,
        onToken: (token) => { content += token; },
      });
      assert.equal(requestBody.model, 'local-coder');
      assert.equal(requestBody.max_tokens, 2048);
      assert.equal(content, generated);
      assert.equal(metrics.finishReason, 'stop');
    });
  }
});

test('streaming chat bounds context and parses tokens, usage and completion', async () => {
  let body;
  const client = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return eventStream([
        'data: {"choices":[{"delta":{"content":"Local "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"stream"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
  });
  const tokens = [];
  const metrics = await client.streamChat({
    message: 'latest question',
    conversation: [{ role: 'user', content: 'old context '.repeat(400) }],
    context: 512,
    maxTokens: 9999,
    onToken: (token) => tokens.push(token),
  });

  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.messages.at(-1).content, 'latest question');
  assert.ok(body.messages.reduce((total, message) => total + message.content.length, 0) <= 512 * 4);
  assert.deepEqual(tokens, ['Local ', 'stream']);
  assert.equal(metrics.provider, 'local');
  assert.equal(metrics.model, 'loaded-coder');
  assert.equal(metrics.inputTokens, 12);
  assert.equal(metrics.outputTokens, 2);
});

test('LM Studio reports unavailable, timeout, missing model and malformed responses explicitly', async () => {
  const unavailable = createLmStudioClient({
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(unavailable.listModels(), (error) => {
    assert.ok(error instanceof LocalModelError);
    assert.equal(error.code, 'UNAVAILABLE');
    assert.doesNotMatch(error.message, /fetch failed/);
    return true;
  });

  const timeout = createLmStudioClient({
    fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); },
  });
  await assert.rejects(timeout.listModels(), { code: 'TIMEOUT' });

  const missing = createLmStudioClient({
    model: 'not-loaded',
    fetchImpl: async () => jsonResponse({ error: 'model not loaded' }, 404),
  });
  await assert.rejects(missing.chatCompletion({ message: 'Hello' }), { code: 'MODEL_NOT_LOADED' });

  const noModelsLoaded = createLmStudioClient({
    model: 'not-loaded',
    fetchImpl: async () => jsonResponse({
      error: {
        message: "No models loaded. Please load a model in the developer page or use the 'lms load' command.",
      },
    }, 400),
  });
  await assert.rejects(noModelsLoaded.chatCompletion({ message: 'Hello' }), { code: 'MODEL_NOT_LOADED' });

  const malformed = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async () => eventStream(['data: not-json\n\n']),
  });
  await assert.rejects(malformed.streamChat({ message: 'Hello', onToken: () => undefined }), {
    code: 'MALFORMED_RESPONSE',
  });
});

test('streaming chat cancellation is reported as cancellation', async () => {
  const controller = new AbortController();
  const client = createLmStudioClient({
    model: 'loaded-coder',
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(streamController) {
        signal.addEventListener('abort', () => streamController.error(signal.reason), { once: true });
      },
    })),
  });
  const pending = client.streamChat({
    message: 'Cancel me',
    signal: controller.signal,
    onToken: () => undefined,
  });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('streaming response timeout is not misreported as user cancellation', async () => {
  const client = createLmStudioClient({
    model: 'loaded-coder',
    timeoutMs: 1000,
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(streamController) {
        signal.addEventListener('abort', () => streamController.error(signal.reason), { once: true });
      },
    })),
  });
  await assert.rejects(
    client.streamChat({ message: 'Wait for timeout', onToken: () => undefined }),
    { code: 'TIMEOUT' },
  );
});

test('LM Studio embeddings validate input and returned vectors', async () => {
  let body;
  const client = createLmStudioClient({
    embeddingModel: 'local-embedding',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:1234/v1/embeddings');
      body = JSON.parse(options.body);
      return jsonResponse({
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      });
    },
  });
  assert.deepEqual(await client.embedTexts(['first', 'second']), [[0.1, 0.2], [0.3, 0.4]]);
  assert.equal(body.model, 'local-embedding');
  assert.deepEqual(body.input, ['first', 'second']);
  await assert.rejects(client.embedTexts([1]), { code: 'INVALID_INPUT' });
  await assert.rejects(
    createLmStudioClient().embedTexts(['text']),
    { code: 'MODEL_NOT_CONFIGURED' },
  );
});
