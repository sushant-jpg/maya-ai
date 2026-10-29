import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudProviders } from '../server/cloud-providers.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

const prompt = {
  message: 'Return a local test response',
  conversation: [{ role: 'user', content: 'Earlier question' }],
  systemPrompt: 'Use brief answers',
  model: 'configured-model',
  temperature: 0.3,
  maxTokens: 512,
  onToken: () => undefined,
};

test('cloud model discovery calls provider catalogs with server-side credentials', async () => {
  const captured = [];
  const providers = createCloudProviders({
    apiKeys: {
      deepseek: 'deepseek-secret',
      openai: 'openai-secret',
      gemini: 'gemini-secret',
      anthropic: 'anthropic-secret',
    },
    fetchImpl: async (url, options) => {
      captured.push({ url: String(url), headers: new Headers(options.headers) });
      if (String(url).includes('generativelanguage.googleapis.com')) {
        return jsonResponse({
          models: [
            { name: 'models/gemini-chat-model', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-embedding-model', supportedGenerationMethods: ['embedContent'] },
          ],
        });
      }
      if (String(url).includes('api.anthropic.com')) return jsonResponse({ data: [{ id: 'claude-chat-model' }] });
      return jsonResponse({
        data: String(url).includes('api.deepseek.com')
          ? [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]
          : [{ id: 'provider-chat-model' }],
      });
    },
  });

  assert.deepEqual(await providers.deepseek.listModels(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(await providers.openai.listModels(), ['provider-chat-model']);
  assert.deepEqual(await providers.gemini.listModels(), ['gemini-chat-model']);
  assert.deepEqual(await providers.anthropic.listModels(), ['claude-chat-model']);
  assert.equal(captured[0].url, 'https://api.deepseek.com/models');
  assert.equal(captured[0].headers.get('authorization'), 'Bearer deepseek-secret');
  assert.equal(captured[1].url, 'https://api.openai.com/v1/models');
  assert.equal(captured[1].headers.get('authorization'), 'Bearer openai-secret');
  assert.equal(captured[2].url, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(captured[2].headers.get('x-goog-api-key'), 'gemini-secret');
  assert.equal(captured[3].headers.get('x-api-key'), 'anthropic-secret');
  assert.equal(providers.anthropic.name, 'Anthropic');
  assert.equal(providers.anthropic.configured, true);
});

test('OpenRouter discovers only text-chat models and labels free pricing from its live catalog', async () => {
  const captured = [];
  const providers = createCloudProviders({
    apiKeys: { openrouter: 'openrouter-server-key' },
    fetchImpl: async (url, options) => {
      captured.push({ url: String(url), headers: new Headers(options.headers) });
      return jsonResponse({
        data: [
          {
            id: 'qwen/qwen3-4b:free',
            name: 'Qwen 3 4B',
            context_length: 32768,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            pricing: { prompt: '0', completion: '0' },
          },
          {
            id: 'openai/chat-model',
            name: 'Chat Model',
            context_length: 8192,
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
          {
            id: 'provider/embedding-model',
            architecture: { input_modalities: ['text'], output_modalities: ['embedding'] },
            pricing: { prompt: '0', completion: '0' },
          },
        ],
      });
    },
  });

  assert.equal(providers.openrouter.name, 'OpenRouter');
  assert.equal(providers.openrouter.configured, true);
  assert.deepEqual(await providers.openrouter.listModels(), ['qwen/qwen3-4b:free', 'openai/chat-model']);
  const details = await providers.openrouter.listModelDetails();
  assert.deepEqual(details, [
    { id: 'qwen/qwen3-4b:free', name: 'Qwen 3 4B', contextLength: 32768, free: true },
    { id: 'openai/chat-model', name: 'Chat Model', contextLength: 8192 },
  ]);
  assert.equal(captured[0].url, 'https://openrouter.ai/api/v1/models');
  assert.match(captured[0].headers.get('authorization') || '', /^Bearer /);
  assert.equal(captured[0].headers.get('x-openrouter-title'), 'Maya AI');
  assert.equal(JSON.stringify(captured).includes('openrouter-server-key'), false);
});

test('OpenRouter is selectable without a key but fails clearly until configured', async () => {
  const provider = createCloudProviders({ apiKeys: {} }).openrouter;
  assert.equal(provider.configured, false);
  assert.equal(provider.enabled, true);
  await assert.rejects(provider.listModels(), {
    code: 'PROVIDER_NOT_CONFIGURED',
    message: /OPENROUTER_API_KEY.*backend \.env.*restart/,
  });
});

test('OpenRouter accepts an empty live catalog and reports provider timeouts', async () => {
  const empty = createCloudProviders({
    apiKeys: { openrouter: 'server-only-key' },
    fetchImpl: async () => jsonResponse({ data: [] }),
  }).openrouter;
  assert.deepEqual(await empty.listModels(), []);
  assert.deepEqual(await empty.listModelDetails(), []);

  const timedOut = createCloudProviders({
    apiKeys: { openrouter: 'server-only-key' },
    fetchImpl: async () => { throw new DOMException('request timed out', 'TimeoutError'); },
  }).openrouter;
  await assert.rejects(timedOut.listModels(), {
    code: 'TIMEOUT',
    message: /OpenRouter request timed out/,
  });
});

test('OpenRouter sends explicit streaming selections and classifies billing failures', async (t) => {
  await t.test('streaming request', async () => {
    let captured;
    const providers = createCloudProviders({
      apiKeys: { openrouter: 'openrouter-server-key' },
      fetchImpl: async (url, options) => {
        captured = { url: String(url), body: JSON.parse(options.body), headers: new Headers(options.headers) };
        return eventStream([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenRouter answer' }, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      },
    });
    const tokens = [];
    const metrics = await providers.openrouter.streamChat({
      ...prompt,
      model: 'qwen/qwen3-4b:free',
      onToken: (token) => tokens.push(token),
    });
    assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(captured.body.model, 'qwen/qwen3-4b:free');
    assert.equal(captured.body.stream, true);
    assert.equal(captured.headers.get('x-openrouter-title'), 'Maya AI');
    assert.deepEqual(tokens, ['OpenRouter answer']);
    assert.equal(metrics.provider, 'openrouter');
    assert.equal(metrics.model, 'qwen/qwen3-4b:free');
  });

  await t.test('billing error', async () => {
    const provider = createCloudProviders({
      apiKeys: { openrouter: 'openrouter-server-key' },
      fetchImpl: async () => jsonResponse({ error: 'private upstream response' }, 402),
    }).openrouter;
    await assert.rejects(provider.listModels(), (error) => {
      assert.equal(error.code, 'PROVIDER_PAYMENT_REQUIRED');
      assert.match(error.message, /credits or billing/);
      assert.doesNotMatch(error.message, /private upstream response|openrouter-server-key/);
      return true;
    });
  });

  await t.test('invalid credentials are sanitized', async () => {
    const provider = createCloudProviders({
      apiKeys: { openrouter: 'invalid-server-key' },
      fetchImpl: async () => jsonResponse({ error: 'private authentication detail' }, 401),
    }).openrouter;
    await assert.rejects(provider.listModels(), (error) => {
      assert.equal(error.code, 'PROVIDER_AUTH_FAILED');
      assert.match(error.message, /rejected its API key/);
      assert.doesNotMatch(error.message, /invalid-server-key|private authentication detail/);
      return true;
    });
  });
});

test('DeepSeek and OpenAI stream the selected model with the OpenAI-compatible API', async (t) => {
  for (const providerId of ['deepseek', 'openai']) {
    await t.test(providerId, async () => {
      let captured;
      const providers = createCloudProviders({
        apiKeys: { [providerId]: 'server-only-key' },
        fetchImpl: async (url, options) => {
          captured = { url: String(url), body: JSON.parse(options.body), headers: new Headers(options.headers) };
          assert.equal(String(url), providerId === 'deepseek'
            ? 'https://api.deepseek.com/chat/completions'
            : 'https://api.openai.com/v1/chat/completions');
          return eventStream([
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'cloud ' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        },
      });
      const tokens = [];
      const model = providerId === 'deepseek' ? 'deepseek-v4-pro' : 'configured-model';
      const metrics = await providers[providerId].streamChat({
        ...prompt,
        model,
        onToken: (token) => tokens.push(token),
      });
      assert.equal(captured.body.model, model);
      assert.deepEqual(captured.body.messages, [
        { role: 'system', content: prompt.systemPrompt },
        ...prompt.conversation,
        { role: 'user', content: prompt.message },
      ]);
      assert.equal(captured.body.stream, true);
      assert.equal(captured.headers.get('authorization'), 'Bearer server-only-key');
      assert.deepEqual(tokens, ['cloud ', 'answer']);
      assert.equal(metrics.provider, providerId);
      assert.equal(metrics.finishReason, 'stop');
    });
  }
});

test('Gemini and Anthropic use their documented streaming message formats', async (t) => {
  const scenarios = [
    {
      id: 'gemini',
      stream: 'data: {"candidates":[{"content":{"parts":[{"text":"Gemini answer"}]},"finishReason":"STOP"}]}\n\n',
      expectedText: 'Gemini answer',
      checkRequest: (captured) => {
        assert.match(captured.url, /:streamGenerateContent\?alt=sse$/);
        assert.doesNotMatch(captured.url, /secret/);
        assert.equal(captured.headers.get('x-goog-api-key'), 'gemini-secret');
        assert.equal(captured.body.contents.at(-1).role, 'user');
        assert.equal(captured.body.systemInstruction.parts[0].text, prompt.systemPrompt);
      },
    },
    {
      id: 'anthropic',
      stream: [
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Anthropic answer"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      ].join(''),
      expectedText: 'Anthropic answer',
      checkRequest: (captured) => {
        assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
        assert.equal(captured.headers.get('anthropic-version'), '2023-06-01');
        assert.equal(captured.body.system, prompt.systemPrompt);
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.id, async () => {
      let captured;
      const providers = createCloudProviders({
        apiKeys: { [scenario.id]: `${scenario.id}-secret` },
        fetchImpl: async (url, options) => {
          captured = { url: String(url), body: JSON.parse(options.body), headers: new Headers(options.headers) };
          return eventStream([scenario.stream]);
        },
      });
      const tokens = [];
      const metrics = await providers[scenario.id].streamChat({
        ...prompt,
        onToken: (token) => tokens.push(token),
      });
      scenario.checkRequest(captured);
      assert.deepEqual(tokens, [scenario.expectedText]);
      assert.equal(metrics.provider, scenario.id);
    });
  }
});

test('cloud providers fail explicitly when not configured and sanitize provider failures', async () => {
  const missing = createCloudProviders({ apiKeys: {} });
  assert.equal(missing.deepseek.configured, false);
  assert.equal(missing.deepseek.enabled, true);
  assert.equal(missing.openai.enabled, false);
  await assert.rejects(missing.deepseek.listModels(), {
    code: 'PROVIDER_NOT_CONFIGURED',
    message: /DEEPSEEK_API_KEY.*backend \.env.*restart/,
  });

  const unauthorized = createCloudProviders({
    apiKeys: { deepseek: 'do-not-echo-this-key' },
    fetchImpl: async () => jsonResponse({ error: { message: 'secret echoed by upstream' } }, 401),
  });
  await assert.rejects(unauthorized.deepseek.listModels(), (error) => {
    assert.equal(error.code, 'PROVIDER_AUTH_FAILED');
    assert.match(error.message, /rejected its API key/);
    assert.doesNotMatch(error.message, /do-not-echo-this-key|secret echoed/);
    return true;
  });
});

test('DeepSeek reads DEEPSEEK_API_KEY from the backend environment', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const testKey = 'test-only-deepseek-key';
  try {
    delete process.env.DEEPSEEK_API_KEY;
    const missing = createCloudProviders({
      fetchImpl: async () => jsonResponse({ data: [{ id: 'deepseek-flash' }] }),
    }).deepseek;
    assert.equal(missing.configured, false);
    await assert.rejects(missing.listModels(), { code: 'PROVIDER_NOT_CONFIGURED' });

    process.env.DEEPSEEK_API_KEY = testKey;
    let captured;
    const configured = createCloudProviders({
      fetchImpl: async (url, options) => {
        captured = { url: String(url), headers: new Headers(options.headers) };
        return jsonResponse({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
      },
    }).deepseek;

    assert.equal(configured.configured, true);
    assert.equal(configured.credentialEnv, 'DEEPSEEK_API_KEY');
    assert.deepEqual(await configured.listModels(), ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(captured.url, 'https://api.deepseek.com/models');
    assert.equal(captured.headers.get('authorization'), `Bearer ${testKey}`);
  } finally {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test('DeepSeek rejects malformed authorization-header values without sending a request', async () => {
  let fetchCalls = 0;
  const provider = createCloudProviders({
    apiKeys: { deepseek: 'test-key-\u2603' },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ data: [] });
    },
  }).deepseek;

  assert.equal(provider.configured, false);
  assert.equal(provider.credentialStatus, 'invalid');
  assert.equal(provider.enabled, true);
  await assert.rejects(provider.listModels(), (error) => {
    assert.equal(error.code, 'PROVIDER_CREDENTIAL_INVALID');
    assert.match(error.message, /DEEPSEEK_API_KEY.*cannot be sent/);
    assert.doesNotMatch(error.message, /test-key/);
    return true;
  });
  assert.equal(fetchCalls, 0);
});

test('cloud provider enable flags prevent calls even when credentials are configured', async () => {
  let fetchCalls = 0;
  const providers = createCloudProviders({
    apiKeys: { openai: 'server-only-key' },
    enabled: { openai: false },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ data: [] });
    },
  });
  assert.equal(providers.openai.configured, true);
  assert.equal(providers.openai.enabled, false);
  await assert.rejects(providers.openai.listModels(), { code: 'PROVIDER_DISABLED' });
  assert.equal(fetchCalls, 0);
});

test('cloud provider diagnostics distinguish authentication, rate limiting, model errors, and outages', async (t) => {
  const statuses = [
    { status: 401, code: 'PROVIDER_AUTH_FAILED' },
    { status: 403, code: 'PROVIDER_ACCESS_DENIED' },
    { status: 402, code: 'PROVIDER_PAYMENT_REQUIRED' },
    { status: 429, code: 'PROVIDER_RATE_LIMITED' },
    { status: 404, code: 'MODEL_NOT_AVAILABLE' },
    { status: 503, code: 'PROVIDER_OUTAGE' },
  ];
  for (const { status, code } of statuses) {
    await t.test(`HTTP ${status}`, async () => {
      const providers = createCloudProviders({
        apiKeys: { openai: 'server-only-key' },
        fetchImpl: async () => jsonResponse({ error: 'private upstream detail' }, status),
      });
      await assert.rejects(providers.openai.listModels(), (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /private upstream detail|server-only-key/);
        if (status === 403) assert.match(error.message, /denied access/);
        if (status === 402) assert.match(error.message, /credits or billing/);
        return true;
      });
    });
  }
});
