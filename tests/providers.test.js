import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { LocalModelError } from '../server/ollama.js';
import { createCloudProviders } from '../server/cloud-providers.js';

test('legacy provider discovery exposes the configured local runtime', async () => {
  const app = createApp({
    ollama: { listModels: async () => ['qwen3:4b'], streamChat: async () => ({}) },
    defaultModel: 'qwen3:4b',
  });

  const response = await request(app).get('/api/providers').expect(200);
  assert.deepEqual(response.body, {
    providers: [{ id: 'local', name: 'Ollama', configured: true, defaultModel: 'qwen3:4b' }],
    defaultProvider: 'local',
    authRequired: false,
  });
});

test('provider listing reports whether the backend API token is required', async () => {
  const app = createApp({
    providers: {
      ollama: {
        id: 'ollama',
        name: 'Ollama',
        local: true,
        configured: true,
        defaultModel: '',
        listModels: async () => [],
        streamChat: async () => ({}),
      },
    },
    defaultProvider: 'ollama',
    authToken: 'a'.repeat(32),
  });
  const response = await request(app).get('/api/providers').set('Authorization', `Bearer ${'a'.repeat(32)}`).expect(200);
  assert.equal(response.body.authRequired, true);
  await request(app).get('/api/auth/status').expect(200).expect(({ body }) => {
    assert.deepEqual(body, { authRequired: true });
  });
});

test('backend auth status is safe to inspect without a token and reports disabled auth', async () => {
  const app = createApp({
    ollama: { listModels: async () => [], streamChat: async () => ({}) },
    defaultModel: '',
  });
  await request(app).get('/api/auth/status').expect(200).expect(({ body }) => {
    assert.deepEqual(body, { authRequired: false });
  });
});

test('cloud inference requests are rejected without invoking local or external providers', async () => {
  let localCalls = 0;
  const app = createApp({
    ollama: {
      listModels: async () => ['qwen3:4b'],
      streamChat: async () => { localCalls += 1; },
    },
    defaultModel: 'qwen3:4b',
  });

  await request(app).post('/api/chat')
    .send({ message: 'Keep this local', provider: 'cloud' })
    .expect(400)
    .expect(({ body }) => assert.equal(body.error, 'Unknown provider selected.'));
  assert.equal(localCalls, 0);
});

test('configured cloud model selection stays explicit and does not invoke local inference', async () => {
  let localCalls = 0;
  const cloudCalls = [];
  const local = {
    id: 'lm-studio',
    name: 'LM Studio',
    local: true,
    configured: true,
    defaultModel: 'local-chat',
    listModels: async () => ['local-chat'],
    streamChat: async () => { localCalls += 1; },
  };
  const deepseek = {
    id: 'deepseek',
    name: 'DeepSeek',
    local: false,
    configured: true,
    defaultModel: '',
    listModels: async () => ['deepseek-flash', 'deepseek-v4-pro'],
    streamChat: async ({ message, model, onToken }) => {
      cloudCalls.push({ message, model });
      onToken('cloud answer');
      return { finishReason: 'stop' };
    },
  };
  const app = createApp({
    ollama: local,
    providers: { 'lm-studio': local, deepseek },
    defaultProvider: 'lm-studio',
    localProviderName: 'LM Studio',
    defaultModel: 'local-chat',
  });

  const discovered = await request(app).get('/api/providers').expect(200);
  assert.deepEqual(discovered.body.defaultProvider, 'lm-studio');
  assert.equal(JSON.stringify(discovered.body).includes('API_KEY'), false);
  const models = await request(app).get('/api/models?provider=deepseek').expect(200);
  assert.deepEqual(models.body.models, ['deepseek-flash', 'deepseek-v4-pro']);
  await request(app).post('/api/chat')
    .send({ provider: 'deepseek', model: 'deepseek-v4-pro', message: 'Explicit cloud request' })
    .expect(200)
    .expect(({ text }) => {
      assert.match(text, /"token":"cloud answer"/);
      assert.match(text, /Cloud provider selected/);
      assert.match(text, /"provider":"deepseek"/);
    });
  assert.deepEqual(cloudCalls, [{ message: 'Explicit cloud request', model: 'deepseek-v4-pro' }]);
  assert.equal(localCalls, 0);
});

test('OpenRouter diagnostics and chat use the selected cloud model without exposing credentials or falling back', async () => {
  let localCalls = 0;
  const routed = [];
  const local = {
    id: 'ollama',
    name: 'Ollama',
    local: true,
    configured: true,
    defaultModel: 'local-model',
    listModels: async () => ['local-model'],
    streamChat: async () => { localCalls += 1; },
  };
  const cloud = createCloudProviders({
    apiKeys: { openrouter: 'server-only-openrouter-key' },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{
            id: 'provider/model:free',
            name: 'Provider Model',
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            pricing: { prompt: '0', completion: '0' },
          }],
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      routed.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenRouter response' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const app = createApp({
    providers: { ollama: local, ...cloud },
    defaultProvider: 'ollama',
    localProviderName: 'Ollama',
    defaultModel: 'local-model',
  });

  await request(app).get('/api/providers').expect(200).expect(({ body }) => {
    const openrouter = body.providers.find((provider) => provider.id === 'openrouter');
    assert.equal(openrouter.name, 'OpenRouter');
    assert.equal(openrouter.configured, true);
    assert.equal(openrouter.credentialEnv, 'OPENROUTER_API_KEY');
    assert.doesNotMatch(JSON.stringify(body), /server-only-openrouter-key/);
  });
  await request(app).post('/api/providers/openrouter/test')
    .send({ model: 'provider/model:free', inference: true })
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.server.status, 'connected');
      assert.equal(body.inference.status, 'passed');
      assert.equal(body.model.status, 'verified');
      assert.equal(body.modelDetails[0].free, true);
    });
  await request(app).post('/api/chat')
    .send({ provider: 'openrouter', model: 'provider/model:free', message: 'Route explicitly' })
    .expect(200)
    .expect(({ text }) => {
      assert.match(text, /"token":"OpenRouter response"/);
      assert.match(text, /"provider":"openrouter"/);
    });
  assert.equal(routed.length, 2);
  assert.ok(routed.every(({ url, body }) => url.endsWith('/chat/completions')
    && body.model === 'provider/model:free' && body.stream === true));
  assert.equal(localCalls, 0);
});

test('OpenRouter billing failures stay actionable at the Maya API boundary', async () => {
  const local = {
    id: 'ollama',
    name: 'Ollama',
    local: true,
    configured: true,
    defaultModel: '',
    listModels: async () => [],
    streamChat: async () => ({}),
  };
  const cloud = createCloudProviders({
    apiKeys: { openrouter: 'server-only-key' },
    fetchImpl: async () => new Response(JSON.stringify({ error: 'private billing detail' }), { status: 402 }),
  });
  const app = createApp({
    providers: { ollama: local, ...cloud },
    defaultProvider: 'ollama',
    localProviderName: 'Ollama',
  });

  await request(app).get('/api/models?provider=openrouter').expect(402).expect(({ body }) => {
    assert.equal(body.code, 'PROVIDER_PAYMENT_REQUIRED');
    assert.match(body.error, /credits or billing/);
    assert.doesNotMatch(body.error, /private billing detail|server-only-key/);
  });
});

test('DeepSeek access-denied responses are distinct from invalid credentials', async () => {
  const local = {
    id: 'ollama',
    name: 'Ollama',
    local: true,
    configured: true,
    defaultModel: '',
    listModels: async () => [],
    streamChat: async () => ({}),
  };
  const deepseek = createCloudProviders({
    apiKeys: { deepseek: 'server-only-key' },
    fetchImpl: async () => new Response(JSON.stringify({ error: 'private upstream detail' }), { status: 403 }),
  });
  const app = createApp({
    providers: { ollama: local, ...deepseek },
    defaultProvider: 'ollama',
    localProviderName: 'Ollama',
  });

  await request(app).get('/api/models?provider=deepseek').expect(403).expect(({ body }) => {
    assert.equal(body.code, 'PROVIDER_ACCESS_DENIED');
    assert.match(body.error, /denied access/);
    assert.doesNotMatch(body.error, /private upstream detail|server-only-key/);
  });
  await request(app).post('/api/providers/deepseek/test').send({}).expect(200).expect(({ body }) => {
    assert.equal(body.server.status, 'connected');
    assert.equal(body.authentication.status, 'failed');
    assert.equal(body.error.code, 'PROVIDER_ACCESS_DENIED');
  });
});

test('malformed DeepSeek keys are reported as invalid without exposing them', async () => {
  const local = {
    id: 'ollama',
    name: 'Ollama',
    local: true,
    configured: true,
    defaultModel: '',
    listModels: async () => [],
    streamChat: async () => ({}),
  };
  const deepseek = createCloudProviders({ apiKeys: { deepseek: 'test-key-\u2603' } });
  const app = createApp({
    providers: { ollama: local, ...deepseek },
    defaultProvider: 'ollama',
    localProviderName: 'Ollama',
  });

  await request(app).get('/api/providers').expect(200).expect(({ body }) => {
    const provider = body.providers.find((item) => item.id === 'deepseek');
    assert.equal(provider.configured, false);
    assert.equal(provider.credentialStatus, 'invalid');
    assert.equal(provider.credentialEnv, 'DEEPSEEK_API_KEY');
    assert.doesNotMatch(JSON.stringify(body), /test-key/);
  });
  await request(app).get('/api/models?provider=deepseek').expect(400).expect(({ body }) => {
    assert.equal(body.code, 'PROVIDER_CREDENTIAL_INVALID');
    assert.match(body.error, /invalid characters/);
    assert.doesNotMatch(JSON.stringify(body), /test-key/);
  });
  await request(app).post('/api/providers/deepseek/test').send({}).expect(200).expect(({ body }) => {
    assert.equal(body.configured, false);
    assert.equal(body.authentication.status, 'failed');
    assert.equal(body.error.code, 'PROVIDER_CREDENTIAL_INVALID');
    assert.doesNotMatch(JSON.stringify(body), /test-key/);
  });
});

test('unconfigured or unavailable cloud providers fail without local fallback', async () => {
  let localCalls = 0;
  const local = {
    id: 'lm-studio',
    name: 'LM Studio',
    local: true,
    configured: true,
    defaultModel: 'local-chat',
    listModels: async () => ['local-chat'],
    streamChat: async () => { localCalls += 1; },
  };
  const unconfigured = {
    id: 'deepseek',
    name: 'DeepSeek',
    local: false,
    configured: false,
    defaultModel: '',
    listModels: async () => { throw new Error('must not list without key'); },
    streamChat: async () => { throw new Error('must not generate without key'); },
  };
  const unavailable = {
    ...unconfigured,
    id: 'openai',
    name: 'OpenAI',
    configured: true,
    listModels: async () => { throw new LocalModelError('PROVIDER_UNAVAILABLE', 'OpenAI is unavailable.'); },
  };
  const app = createApp({
    providers: { 'lm-studio': local, deepseek: unconfigured, openai: unavailable },
    defaultProvider: 'lm-studio',
    localProviderName: 'LM Studio',
    defaultModel: 'local-chat',
  });
  await request(app).get('/api/models?provider=deepseek').expect(503)
    .expect(({ body }) => assert.equal(body.code, 'PROVIDER_NOT_CONFIGURED'));
  await request(app).post('/api/chat')
    .send({ provider: 'deepseek', model: 'deepseek-flash', message: 'Must not fall back' })
    .expect(503)
    .expect(({ body }) => assert.equal(body.code, 'PROVIDER_NOT_CONFIGURED'));
  await request(app).post('/api/chat')
    .send({ provider: 'openai', model: 'gpt-test', message: 'Must fail explicitly' })
    .expect(502)
    .expect(({ body }) => assert.equal(body.code, 'PROVIDER_UNAVAILABLE'));
  assert.equal(localCalls, 0);
});

test('DeepSeek is selectable without credentials and gives server-only setup guidance', async () => {
  let localCalls = 0;
  const local = {
    id: 'lm-studio',
    name: 'LM Studio',
    local: true,
    configured: true,
    defaultModel: 'local-chat',
    listModels: async () => ['local-chat'],
    streamChat: async () => { localCalls += 1; },
  };
  const deepseek = createCloudProviders({ apiKeys: {} }).deepseek;
  const app = createApp({
    providers: { 'lm-studio': local, deepseek },
    defaultProvider: 'lm-studio',
    localProviderName: 'LM Studio',
    defaultModel: 'local-chat',
  });

  await request(app).get('/api/providers').expect(200).expect(({ body }) => {
    const listed = body.providers.find((provider) => provider.id === 'deepseek');
    assert.deepEqual(
      { configured: listed.configured, enabled: listed.enabled, credentialEnv: listed.credentialEnv },
      { configured: false, enabled: true, credentialEnv: 'DEEPSEEK_API_KEY' },
    );
    assert.doesNotMatch(JSON.stringify(body), /apiKey|secret/i);
  });
  await request(app).post('/api/providers/deepseek/test').send({}).expect(200).expect(({ body }) => {
    assert.equal(body.configured, false);
    assert.equal(body.authentication.status, 'not_configured');
    assert.match(body.error.message, /DEEPSEEK_API_KEY.*backend \.env.*restart/);
  });
  await request(app).get('/api/models?provider=deepseek').expect(503).expect(({ body }) => {
    assert.equal(body.code, 'PROVIDER_NOT_CONFIGURED');
    assert.match(body.error, /DEEPSEEK_API_KEY/);
  });
  await request(app).post('/api/chat')
    .send({ provider: 'deepseek', model: 'deepseek-flash', message: 'No local fallback' })
    .expect(503)
    .expect(({ body }) => {
      assert.equal(body.code, 'PROVIDER_NOT_CONFIGURED');
      assert.match(body.error, /DEEPSEEK_API_KEY/);
    });
  assert.equal(localCalls, 0);
});

test('LM Studio configuration is reported as the only local provider', async () => {
  const calls = { listModels: 0, streamChat: [] };
  const lmStudio = {
    listModels: async () => {
      calls.listModels += 1;
      return ['loaded-coder'];
    },
    streamChat: async ({ message, model, onToken }) => {
      calls.streamChat.push({ message, model });
      onToken('local result');
      return {};
    },
  };
  const app = createApp({
    ollama: lmStudio,
    localProviderName: 'LM Studio',
    defaultModel: 'loaded-coder',
  });

  const providerResponse = await request(app).get('/api/providers').expect(200);
  assert.deepEqual(providerResponse.body, {
    providers: [{ id: 'local', name: 'LM Studio', configured: true, defaultModel: 'loaded-coder' }],
    defaultProvider: 'local',
    authRequired: false,
  });
  const healthResponse = await request(app).get('/api/health').expect(200);
  assert.equal(healthResponse.body.status, 'ready');
  assert.equal(healthResponse.body.model, 'loaded-coder');

  for (const message of ['PONG', 'Write a JavaScript function that adds two numbers']) {
    const response = await request(app).post('/api/chat')
      .send({ message, provider: 'local', model: 'loaded-coder' })
      .expect(200);
    assert.match(response.text, /"token":"local result"/);
  }

  assert.equal(calls.listModels, 3, 'health and each chat request verify the selected model');
  assert.deepEqual(calls.streamChat, [
    { message: 'PONG', model: 'loaded-coder' },
    { message: 'Write a JavaScript function that adds two numbers', model: 'loaded-coder' },
  ]);
});

test('explicit Ollama configuration continues to use Ollama for health and chat', async () => {
  const calls = { listModels: 0, streamChat: 0 };
  const ollama = {
    listModels: async () => {
      calls.listModels += 1;
      return ['qwen3:4b'];
    },
    streamChat: async ({ onToken }) => {
      calls.streamChat += 1;
      onToken('ollama result');
      return {};
    },
  };
  const app = createApp({
    ollama,
    localProviderName: 'Ollama',
    defaultModel: 'qwen3:4b',
  });

  await request(app).get('/api/health').expect(200)
    .expect(({ body }) => assert.equal(body.ollama, 'connected'));
  assert.deepEqual(calls, { listModels: 1, streamChat: 0 });

  const chatResponse = await request(app).post('/api/chat')
    .send({ message: 'Write a JavaScript function that adds two numbers', provider: 'local', model: 'qwen3:4b' })
    .expect(200);
  assert.match(chatResponse.text, /"token":"ollama result"/);
  assert.deepEqual(calls, { listModels: 2, streamChat: 1 });
});

test('provider diagnostics verify server, authentication, selected model, and optional inference', async () => {
  const calls = [];
  const cloud = {
    id: 'openai',
    name: 'OpenAI',
    local: false,
    configured: true,
    credentialEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    listModels: async () => ['gpt-test'],
    streamChat: async (options) => {
      calls.push({ model: options.model, signal: options.signal });
      options.onToken('MAYA_CONNECTION_OK');
    },
  };
  const app = createApp({ providers: { openai: cloud }, defaultProvider: 'openai' });

  const connection = await request(app).post('/api/providers/openai/test')
    .send({ model: 'gpt-test' })
    .expect(200);
  assert.equal(connection.body.server.status, 'connected');
  assert.equal(connection.body.authentication.status, 'verified');
  assert.equal(connection.body.model.status, 'available');
  assert.deepEqual(connection.body.modelStates, [{
    id: 'gpt-test',
    installed: null,
    available: true,
    verified: false,
    selected: true,
  }]);
  assert.deepEqual(connection.body.verifiedModels, []);
  assert.equal(connection.body.inference.status, 'not_requested');
  assert.equal(connection.body.endpoint, 'https://api.openai.com/v1');
  assert.equal(JSON.stringify(connection.body).includes('OPENAI_API_KEY'), false);

  const inference = await request(app).post('/api/providers/openai/test')
    .send({ model: 'gpt-test', inference: true })
    .expect(200);
  assert.equal(inference.body.inference.status, 'passed');
  assert.equal(inference.body.model.status, 'verified');
  assert.deepEqual(inference.body.verifiedModels, ['gpt-test']);
  assert.equal(inference.body.modelStates[0].verified, true);
  const refreshed = await request(app).post('/api/providers/openai/test')
    .send({ model: 'gpt-test' })
    .expect(200);
  assert.equal(refreshed.body.model.status, 'verified');
  assert.deepEqual(refreshed.body.verifiedModels, ['gpt-test']);
  assert.equal(refreshed.body.modelStates[0].verified, true);
  assert.deepEqual(calls.map(({ model }) => model), ['gpt-test']);

  const missingModel = await request(app).post('/api/providers/openai/test')
    .send({ model: 'not-available', inference: true })
    .expect(200);
  assert.equal(missingModel.body.server.status, 'connected');
  assert.equal(missingModel.body.model.status, 'unavailable');
  assert.equal(missingModel.body.inference.status, 'not_tested');
  assert.equal(calls.length, 1, 'an unavailable model must not be sent to chat');
});

test('provider diagnostics preserve each provider model list and verify only successful inference', async () => {
  const providers = {
    ollama: {
      id: 'ollama',
      name: 'Ollama',
      local: true,
      configured: true,
      defaultModel: '',
      listModels: async () => ['shared:tag', 'qwen3:4b', 'llama3.2:latest'],
      listModelDetails: async () => [
        { id: 'shared:tag', family: 'shared', parameterSize: '2B', sizeBytes: 1024 },
        { id: 'qwen3:4b', family: 'qwen3', families: ['qwen3'], parameterSize: '4.0B', sizeBytes: 2497293931 },
        { id: 'llama3.2:latest' },
      ],
      streamChat: async () => undefined,
    },
    'lm-studio': {
      id: 'lm-studio',
      name: 'LM Studio',
      local: true,
      configured: true,
      baseUrl: 'http://127.0.0.1:1234/v1',
      defaultModel: '',
      listModels: async () => ['shared:tag', 'loaded-coder'],
      streamChat: async () => undefined,
    },
  };
  const app = createApp({ providers, defaultProvider: 'ollama' });

  const ollama = await request(app).post('/api/providers/ollama/test').send({ model: 'shared:tag' }).expect(200);
  assert.deepEqual(ollama.body.models, ['shared:tag', 'qwen3:4b', 'llama3.2:latest']);
  assert.equal(ollama.body.modelStates[0].installed, true);
  assert.equal(ollama.body.modelStates[0].selected, true);
  assert.deepEqual(ollama.body.modelDetails[0], {
    id: 'shared:tag',
    family: 'shared',
    parameterSize: '2B',
    sizeBytes: 1024,
  });
  assert.deepEqual(ollama.body.verifiedModels, []);

  const lmStudio = await request(app).post('/api/providers/lm-studio/test').send({ model: 'shared:tag' }).expect(200);
  assert.deepEqual(lmStudio.body.models, ['shared:tag', 'loaded-coder']);
  assert.equal(lmStudio.body.modelStates[0].installed, null);
  assert.equal(lmStudio.body.modelStates[0].selected, true);
  assert.equal(lmStudio.body.provider.id, 'lm-studio');

  const failedInference = await request(app).post('/api/providers/ollama/test')
    .send({ model: 'qwen3:4b', inference: true }).expect(200);
  assert.equal(failedInference.body.inference.status, 'failed');
  assert.equal(failedInference.body.model.status, 'available');
  assert.deepEqual(failedInference.body.verifiedModels, []);
  assert.equal(failedInference.body.modelStates.find((item) => item.id === 'qwen3:4b').verified, false);
});

test('provider diagnostics reject malformed discovery results without exposing internals', async () => {
  const provider = {
    id: 'ollama',
    name: 'Ollama',
    local: true,
    configured: true,
    defaultModel: '',
    listModels: async () => ['valid-model', '  '],
    streamChat: async () => { throw new Error('must not run'); },
  };
  const app = createApp({ providers: { ollama: provider }, defaultProvider: 'ollama' });
  await request(app).post('/api/providers/ollama/test').send({}).expect(200).expect(({ body }) => {
    assert.equal(body.server.status, 'error');
    assert.equal(body.error.code, 'MALFORMED_RESPONSE');
    assert.deepEqual(body.models, []);
    assert.doesNotMatch(JSON.stringify(body), /internal/);
  });
});

test('provider diagnostics redact credential failures and report unavailable servers', async () => {
  const denied = {
    id: 'deepseek',
    name: 'DeepSeek',
    local: false,
    configured: true,
    credentialEnv: 'DEEPSEEK_API_KEY',
    defaultModel: '',
    listModels: async () => { throw new LocalModelError('PROVIDER_AUTH_FAILED', 'Upstream echoed a secret value'); },
    streamChat: async () => { throw new Error('must not run'); },
  };
  const unavailable = {
    ...denied,
    id: 'lm-studio',
    name: 'LM Studio',
    local: true,
    configured: true,
    listModels: async () => { throw new LocalModelError('UNAVAILABLE', 'internal URL and error detail'); },
  };
  const app = createApp({ providers: { deepseek: denied, 'lm-studio': unavailable }, defaultProvider: 'lm-studio' });

  await request(app).post('/api/providers/deepseek/test').send({}).expect(200).expect(({ body }) => {
    assert.equal(body.server.status, 'connected');
    assert.equal(body.authentication.status, 'failed');
    assert.equal(body.error.code, 'PROVIDER_AUTH_FAILED');
    assert.doesNotMatch(JSON.stringify(body), /secret value/);
  });
  await request(app).post('/api/providers/lm-studio/test').send({}).expect(200).expect(({ body }) => {
    assert.equal(body.server.status, 'disconnected');
    assert.equal(body.authentication.status, 'not_required');
    assert.equal(body.error.code, 'UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(body), /internal URL and error detail/);
  });
});

test('provider diagnostics report missing server-side credentials without exposing secrets', async () => {
  const cloud = {
    id: 'gemini',
    name: 'Google Gemini',
    local: false,
    configured: false,
    credentialEnv: 'GOOGLE_API_KEY',
    defaultModel: '',
    listModels: async () => { throw new Error('must not list models'); },
    streamChat: async () => { throw new Error('must not chat'); },
  };
  const app = createApp({ providers: { gemini: cloud }, defaultProvider: 'gemini' });
  await request(app).post('/api/providers/gemini/test').send({}).expect(200).expect(({ body }) => {
    assert.equal(body.configured, false);
    assert.equal(body.authentication.status, 'not_configured');
    assert.match(body.error.message, /GOOGLE_API_KEY/);
    assert.doesNotMatch(JSON.stringify(body), /secret-value/);
  });
});

test('provider diagnostics do not call an inference model when model discovery is empty', async () => {
  const provider = {
    id: 'lm-studio',
    name: 'LM Studio',
    local: true,
    configured: true,
    defaultModel: '',
    listModels: async () => [],
    streamChat: async () => { throw new Error('inference must not run'); },
  };
  const app = createApp({ providers: { 'lm-studio': provider }, defaultProvider: 'lm-studio' });
  await request(app).post('/api/providers/lm-studio/test').send({ inference: true }).expect(200).expect(({ body }) => {
    assert.equal(body.server.status, 'connected');
    assert.equal(body.model.status, 'unavailable');
    assert.equal(body.inference.status, 'not_tested');
    assert.match(body.error.message, /no available chat models/);
  });
});

test('disabled cloud providers cannot be selected or tested', async () => {
  const disabled = {
    id: 'openai',
    name: 'OpenAI',
    local: false,
    configured: true,
    enabled: false,
    defaultModel: '',
    listModels: async () => { throw new Error('must not fetch models'); },
    streamChat: async () => { throw new Error('must not chat'); },
  };
  const app = createApp({ providers: { openai: disabled }, defaultProvider: 'openai' });
  await request(app).get('/api/providers').expect(200).expect(({ body }) => {
    assert.equal(body.providers[0].configured, true);
    assert.equal(body.providers[0].enabled, false);
  });
  await request(app).get('/api/models?provider=openai').expect(503)
    .expect(({ body }) => assert.equal(body.code, 'PROVIDER_DISABLED'));
  await request(app).post('/api/providers/openai/test').send({}).expect(200).expect(({ body }) => {
    assert.equal(body.configured, true);
    assert.equal(body.error.code, 'PROVIDER_DISABLED');
  });
  await request(app).post('/api/chat').send({ message: 'do not route', provider: 'openai', model: 'gpt-test' })
    .expect(503)
    .expect(({ body }) => assert.equal(body.code, 'PROVIDER_DISABLED'));
});

test('provider diagnostics time out inference tests and validate request bodies', async () => {
  const hanging = {
    id: 'ollama',
    name: 'Ollama',
    local: true,
    configured: true,
    defaultModel: 'qwen3:4b',
    listModels: async () => ['qwen3:4b'],
    streamChat: async ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true });
    }),
  };
  const app = createApp({
    providers: { ollama: hanging },
    defaultProvider: 'ollama',
    providerTestTimeoutMs: 1000,
  });

  await request(app).post('/api/providers/ollama/test')
    .send({ model: 'qwen3:4b', inference: true })
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.server.status, 'connected');
      assert.equal(body.inference.status, 'failed');
      assert.equal(body.error.code, 'TIMEOUT');
    });
  await request(app).post('/api/providers/ollama/test').send({ inference: 'yes' }).expect(400);
  await request(app).post('/api/providers/unknown/test').send({}).expect(404);
});

test('provider inference diagnostic timeout must be a bounded whole number of milliseconds', () => {
  const provider = {
    id: 'ollama',
    name: 'Ollama',
    local: true,
    configured: true,
    listModels: async () => [],
    streamChat: async () => undefined,
  };
  for (const providerTestTimeoutMs of [0, 999, 120001, 1500.5, Number.NaN]) {
    assert.throws(() => createApp({
      providers: { ollama: provider },
      defaultProvider: 'ollama',
      providerTestTimeoutMs,
    }), /MAYA_PROVIDER_TEST_TIMEOUT_MS/);
  }
});
