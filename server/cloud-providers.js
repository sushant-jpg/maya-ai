import { performance } from 'node:perf_hooks';
import { LocalModelError } from './ollama.js';

const DEFINITIONS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    endpoint: '/chat/completions',
    modelEndpoint: '/models',
    credentialEnv: 'DEEPSEEK_API_KEY',
    selectableWithoutKey: true,
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    endpoint: '/chat/completions',
    modelEndpoint: '/models',
    credentialEnv: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    endpoint: '/chat/completions',
    modelEndpoint: '/models',
    credentialEnv: 'OPENROUTER_API_KEY',
    selectableWithoutKey: true,
    headers: { 'X-OpenRouter-Title': 'Maya AI' },
  },
};

function timeoutSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safeProviderError(provider, response) {
  if (response.status === 401) {
    return new LocalModelError('PROVIDER_AUTH_FAILED', `${provider} rejected its API key. Check the server-side API key configuration.`);
  }
  if (response.status === 403) {
    return new LocalModelError('PROVIDER_ACCESS_DENIED', `${provider} denied access (HTTP 403). Check account permissions and whether this model is enabled for the API key.`);
  }
  if (response.status === 402) {
    return new LocalModelError('PROVIDER_PAYMENT_REQUIRED', `${provider} requires account credits or billing. Check your provider account before retrying.`);
  }
  if (response.status === 429) {
    return new LocalModelError('PROVIDER_RATE_LIMITED', `${provider} rate limit or quota was reached. Check the provider account and retry later.`);
  }
  if (response.status === 404) {
    return new LocalModelError('MODEL_NOT_AVAILABLE', `${provider} could not find the requested model or endpoint. Check the selected model and provider API version.`);
  }
  if (response.status >= 500) {
    return new LocalModelError('PROVIDER_OUTAGE', `${provider} is reporting a service outage (HTTP ${response.status}). Retry after checking provider status.`);
  }
  return new LocalModelError('PROVIDER_REQUEST_FAILED', `${provider} request failed (HTTP ${response.status}). Check the provider status and configuration.`);
}

function requestFailure(provider, error, signal) {
  if (signal?.aborted) {
    return signal.reason?.name === 'TimeoutError'
      ? new LocalModelError('TIMEOUT', `${provider} request timed out.`)
      : new LocalModelError('CANCELLED', 'Generation was cancelled.');
  }
  if (error?.name === 'TimeoutError') return new LocalModelError('TIMEOUT', `${provider} request timed out.`);
  return new LocalModelError('PROVIDER_UNAVAILABLE', `${provider} is unavailable. Check its service and network connection.`);
}

function parseJson(text, provider, endpoint) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LocalModelError('MALFORMED_RESPONSE', `${provider} returned an invalid ${endpoint} response.`, { cause: error });
  }
}

async function readJsonResponse(response, provider, endpoint) {
  const text = await response.text();
  if (!response.ok) throw safeProviderError(provider, response);
  return parseJson(text, provider, endpoint);
}

function validateModels(models, provider) {
  if (!Array.isArray(models) || models.some((model) => typeof model !== 'string' || !model.trim())) {
    throw new LocalModelError('MALFORMED_RESPONSE', `${provider} returned an invalid model list.`);
  }
  return [...new Set(models)];
}

function getCredentialStatus(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey) return 'missing';
  return /[^\x21-\x7e]/.test(apiKey) ? 'invalid' : 'configured';
}

function invalidCredentialError(provider, credentialEnv) {
  return new LocalModelError(
    'PROVIDER_CREDENTIAL_INVALID',
    `${provider} ${credentialEnv} contains characters that cannot be sent in an API authorization header. Replace it with the exact key from the official provider dashboard, then restart Maya.`,
  );
}

function modelSupportsTextChat(model) {
  const architecture = model?.architecture;
  const inputModalities = architecture?.input_modalities;
  const outputModalities = architecture?.output_modalities;
  return (!Array.isArray(inputModalities) || inputModalities.includes('text'))
    && (!Array.isArray(outputModalities) || outputModalities.includes('text'));
}

function isZeroPrice(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const price = Number(value);
  return Number.isFinite(price) && price === 0;
}

function createOpenRouterModelDetails(body) {
  if (!Array.isArray(body?.data)) {
    throw new LocalModelError('MALFORMED_RESPONSE', 'OpenRouter returned an invalid model list.');
  }
  const models = body.data.filter(modelSupportsTextChat);
  const ids = validateModels(models.map((model) => model?.id), 'OpenRouter');
  return models.map((model, index) => ({
    id: ids[index],
    ...(typeof model.name === 'string' && model.name.trim() ? { name: model.name } : {}),
    ...(Number.isSafeInteger(model.context_length) && model.context_length > 0
      ? { contextLength: model.context_length }
      : {}),
    ...(isZeroPrice(model.pricing?.prompt) && isZeroPrice(model.pricing?.completion) ? { free: true } : {}),
  }));
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function isProviderEnabled(value) {
  return !['false', '0', 'no', 'off'].includes(String(value ?? 'true').trim().toLowerCase());
}

function readEventData(event) {
  return event.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

async function consumeSse(response, provider, signal, onToken, parseEvent) {
  if (!response.body) throw new LocalModelError('MALFORMED_RESPONSE', `${provider} returned an empty streaming response.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason;
  let firstTokenMs = null;
  let hasVisibleText = false;
  const startedAt = performance.now();
  const emit = (text) => {
    if (!text) return;
    hasVisibleText = true;
    if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
    onToken(text);
  };
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw requestFailure(provider, error, signal);
      }
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) {
        const data = readEventData(event);
        if (!data || data === '[DONE]') continue;
        const payload = parseJson(data, provider, 'stream');
        const result = await parseEvent(payload, emit);
        if (result) finishReason = result;
      }
      if (chunk.done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = readEventData(buffer);
      if (data && data !== '[DONE]') {
        const payload = parseJson(data, provider, 'stream');
        const result = await parseEvent(payload, emit);
        if (result) finishReason = result;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!hasVisibleText) throw new LocalModelError('GENERATION_FAILED', `${provider} returned no user-visible assistant content.`);
  return {
    firstTokenMs,
    totalMs: Math.round(performance.now() - startedAt),
    ...(finishReason ? { finishReason } : {}),
  };
}

function createOpenAiCompatibleProvider(id, definition, fetchImpl, timeoutMs) {
  const credentialEnv = definition.credentialEnv;
  const credentialStatus = getCredentialStatus(definition.apiKey);
  async function request(path, options = {}) {
    if (credentialStatus === 'missing') throw new LocalModelError('PROVIDER_NOT_CONFIGURED', `${definition.name} is not configured. Set ${credentialEnv} in the backend .env file, then restart the Maya server.`);
    if (credentialStatus === 'invalid') throw invalidCredentialError(definition.name, credentialEnv);
    if (!definition.enabled) throw new LocalModelError('PROVIDER_DISABLED', `${definition.name} is disabled in the backend configuration.`);
    const signal = timeoutSignal(timeoutMs, options.signal);
    try {
      const response = await fetchImpl(`${definition.baseUrl}${path}`, {
        ...options,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${definition.apiKey}`,
          ...definition.headers,
          ...options.headers,
        },
        signal,
      });
      return { response, signal };
    } catch (error) {
      throw requestFailure(definition.name, error, signal);
    }
  }

  return {
    id,
    name: definition.name,
    local: false,
    configured: credentialStatus === 'configured',
    credentialStatus,
    enabled: definition.enabled && (credentialStatus === 'configured' || definition.selectableWithoutKey === true),
    defaultModel: '',
    baseUrl: definition.baseUrl,
    credentialEnv,
    async listModels() {
      const { response } = await request(definition.modelEndpoint, { headers: { Accept: 'application/json' } });
      const body = await readJsonResponse(response, definition.name, 'model list');
      if (id === 'openrouter') return createOpenRouterModelDetails(body).map((model) => model.id);
      return validateModels(body?.data?.map((item) => item?.id), definition.name);
    },
    ...(id === 'openrouter' ? {
      async listModelDetails() {
        const { response } = await request(definition.modelEndpoint, { headers: { Accept: 'application/json' } });
        return createOpenRouterModelDetails(await readJsonResponse(response, definition.name, 'model list'));
      },
    } : {}),
    async streamChat(options) {
      const { response, signal } = await request(definition.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        signal: options.signal,
        body: JSON.stringify({
          model: options.model,
          messages: [
            ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
            ...options.conversation,
            { role: 'user', content: options.message },
          ],
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          stream: true,
        }),
      });
      if (!response.ok) throw safeProviderError(definition.name, response);
      return {
        provider: id,
        model: options.model,
        ...await consumeSse(response, definition.name, signal, options.onToken, (payload, emit) => {
          if (payload?.error) throw new LocalModelError('PROVIDER_REQUEST_FAILED', `${definition.name} reported a generation error.`);
          const choice = payload?.choices?.[0];
          const text = contentText(choice?.delta?.content);
          emit(text);
          return choice?.finish_reason || undefined;
        }),
      };
    },
  };
}

function createGoogleProvider(apiKey, enabled, fetchImpl, timeoutMs) {
  const id = 'gemini';
  const name = 'Google Gemini';
  async function request(url, options = {}) {
    if (!apiKey) throw new LocalModelError('PROVIDER_NOT_CONFIGURED', `${name} is not configured. Set GOOGLE_API_KEY in the backend .env file.`);
    if (!enabled) throw new LocalModelError('PROVIDER_DISABLED', `${name} is disabled in the backend configuration.`);
    const signal = timeoutSignal(timeoutMs, options.signal);
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal });
      return { response, signal };
    } catch (error) {
      throw requestFailure(name, error, signal);
    }
  }
  return {
    id,
    name,
    local: false,
    configured: Boolean(apiKey),
    enabled: Boolean(apiKey) && enabled,
    defaultModel: '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    credentialEnv: 'GOOGLE_API_KEY',
    async listModels() {
      const { response } = await request('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { Accept: 'application/json', 'x-goog-api-key': apiKey },
      });
      const body = await readJsonResponse(response, name, 'model list');
      const models = Array.isArray(body?.models)
        ? body.models.filter((model) => Array.isArray(model.supportedGenerationMethods)
          && model.supportedGenerationMethods.includes('generateContent')
          && typeof model.name === 'string')
          .map((model) => model.name.replace(/^models\//, ''))
        : null;
      return validateModels(models, name);
    },
    async streamChat(options) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;
      const contents = [
        ...options.conversation.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        { role: 'user', parts: [{ text: options.message }] },
      ];
      const { response, signal } = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-goog-api-key': apiKey },
        signal: options.signal,
        body: JSON.stringify({
          contents,
          ...(options.systemPrompt ? { systemInstruction: { parts: [{ text: options.systemPrompt }] } } : {}),
          generationConfig: { temperature: options.temperature, maxOutputTokens: options.maxTokens },
        }),
      });
      if (!response.ok) throw safeProviderError(name, response);
      return {
        provider: id,
        model: options.model,
        ...await consumeSse(response, name, signal, options.onToken, (payload, emit) => {
          for (const part of payload?.candidates?.[0]?.content?.parts || []) {
            if (typeof part?.text === 'string') emit(part.text);
          }
          return payload?.candidates?.[0]?.finishReason || undefined;
        }),
      };
    },
  };
}

function createAnthropicProvider(apiKey, enabled, fetchImpl, timeoutMs) {
  const id = 'anthropic';
  const name = 'Anthropic';
  async function request(path, options = {}) {
    if (!apiKey) throw new LocalModelError('PROVIDER_NOT_CONFIGURED', `${name} is not configured. Set ANTHROPIC_API_KEY in the backend .env file.`);
    if (!enabled) throw new LocalModelError('PROVIDER_DISABLED', `${name} is disabled in the backend configuration.`);
    const signal = timeoutSignal(timeoutMs, options.signal);
    try {
      const response = await fetchImpl(`https://api.anthropic.com/v1${path}`, {
        ...options,
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...options.headers,
        },
        signal,
      });
      return { response, signal };
    } catch (error) {
      throw requestFailure(name, error, signal);
    }
  }
  return {
    id,
    name,
    local: false,
    configured: Boolean(apiKey),
    enabled: Boolean(apiKey) && enabled,
    defaultModel: '',
    baseUrl: 'https://api.anthropic.com/v1',
    credentialEnv: 'ANTHROPIC_API_KEY',
    async listModels() {
      const { response } = await request('/models', { headers: { Accept: 'application/json' } });
      const body = await readJsonResponse(response, name, 'model list');
      return validateModels(body?.data?.map((item) => item?.id), name);
    },
    async streamChat(options) {
      const { response, signal } = await request('/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        signal: options.signal,
        body: JSON.stringify({
          model: options.model,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
          stream: true,
          ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
          messages: [
            ...options.conversation.map(({ role, content }) => ({ role: role === 'assistant' ? 'assistant' : 'user', content })),
            { role: 'user', content: options.message },
          ],
        }),
      });
      if (!response.ok) throw safeProviderError(name, response);
      return {
        provider: id,
        model: options.model,
        ...await consumeSse(response, name, signal, options.onToken, (payload, emit) => {
          if (payload?.type === 'error') throw new LocalModelError('PROVIDER_REQUEST_FAILED', `${name} reported a generation error.`);
          if (payload?.type === 'content_block_delta' && payload.delta?.type === 'text_delta') emit(payload.delta.text);
          return payload?.type === 'message_delta' ? payload.delta?.stop_reason : undefined;
        }),
      };
    },
  };
}

export function createCloudProviders({
  fetchImpl = fetch,
  timeoutMs = Number(process.env.MAYA_PROVIDER_TIMEOUT_MS || 120000),
  apiKeys = {
    deepseek: process.env.DEEPSEEK_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    gemini: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
  },
  enabled = {
    deepseek: process.env.MAYA_ENABLE_DEEPSEEK,
    openai: process.env.MAYA_ENABLE_OPENAI,
    openrouter: process.env.MAYA_ENABLE_OPENROUTER,
    gemini: process.env.MAYA_ENABLE_GEMINI,
    anthropic: process.env.MAYA_ENABLE_ANTHROPIC,
  },
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error('MAYA_PROVIDER_TIMEOUT_MS must be between 1000 and 600000 milliseconds.');
  }
  const deepseek = { ...DEFINITIONS.deepseek, apiKey: apiKeys.deepseek || '', enabled: isProviderEnabled(enabled.deepseek) };
  const openai = { ...DEFINITIONS.openai, apiKey: apiKeys.openai || '', enabled: isProviderEnabled(enabled.openai) };
  const openrouter = { ...DEFINITIONS.openrouter, apiKey: apiKeys.openrouter || '', enabled: isProviderEnabled(enabled.openrouter) };
  const geminiEnabled = isProviderEnabled(enabled.gemini);
  const anthropicEnabled = isProviderEnabled(enabled.anthropic);
  return {
    deepseek: createOpenAiCompatibleProvider('deepseek', deepseek, fetchImpl, timeoutMs),
    openai: createOpenAiCompatibleProvider('openai', openai, fetchImpl, timeoutMs),
    openrouter: createOpenAiCompatibleProvider('openrouter', openrouter, fetchImpl, timeoutMs),
    gemini: createGoogleProvider(apiKeys.gemini || '', geminiEnabled, fetchImpl, timeoutMs),
    anthropic: createAnthropicProvider(apiKeys.anthropic || '', anthropicEnabled, fetchImpl, timeoutMs),
  };
}
