import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteFeedback, deleteMemory, fetchBackendAuthStatus, fetchDocumentStorageHealth, fetchFeedback, fetchMemories, fetchModels, saveMemory, streamChat, submitFeedback, testProviderConnection, type ChatRequest } from "../lib/api";

const request: ChatRequest = {
  message: "Say hello",
  provider: "local",
  conversation: [],
  model: "qwen3:4b",
  temperature: 0.7,
  context: 2048,
  maxTokens: 256,
  systemPrompt: "",
  webSearch: false,
  useMemory: false,
};

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("streamChat parses token, source, warning, and completion events across chunks", async () => {
  const tokens: string[] = [];
  const warnings: string[] = [];
  const sources: unknown[] = [];
  const metrics: unknown[] = [];
  const events = [
    `data: ${JSON.stringify({ token: "Hello " })}\n\n`,
    `data: ${JSON.stringify({ sources: [{ kind: "document", fileName: "guide.md", chunkIndex: 0 }] })}\n\n`,
    `data: ${JSON.stringify({ warning: "Search was skipped" })}\n\n`,
    `data: ${JSON.stringify({ metrics: { provider: "local", model: "qwen3:4b", totalMs: 120, finishReason: "length" } })}\n\n`,
    `data: ${JSON.stringify({ token: "Maya" })}\n\n`,
    `data: ${JSON.stringify({ done: true })}\n\n`,
  ].join("");

  await streamChat(request, {
    signal: new AbortController().signal,
    fetchImpl: async () => responseFromChunks([events.slice(0, 27), events.slice(27)]),
    onToken: (token) => tokens.push(token),
    onSources: (value) => sources.push(...value),
    onWarning: (warning) => warnings.push(warning),
    onMetrics: (value) => metrics.push(value),
  });

  assert.deepEqual(tokens, ["Hello ", "Maya"]);
  assert.deepEqual(warnings, ["Search was skipped"]);
  assert.equal(sources[0] && (sources[0] as { fileName: string }).fileName, "guide.md");
  assert.deepEqual(metrics, [{ provider: "local", model: "qwen3:4b", totalMs: 120, finishReason: "length" }]);
});

test("streamChat surfaces backend SSE errors", async () => {
  await assert.rejects(
    streamChat(request, {
      signal: new AbortController().signal,
      fetchImpl: async () => responseFromChunks([`data: ${JSON.stringify({ error: "Model is missing" })}\n\n`]),
      onToken: () => undefined,
      onSources: () => undefined,
      onWarning: () => undefined,
      onMetrics: () => undefined,
    }),
    /Model is missing/,
  );
});

test("streamChat propagates user cancellation", async () => {
  const cancellation = new AbortController();
  const pending = streamChat(request, {
    signal: cancellation.signal,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
    onToken: () => undefined,
    onSources: () => undefined,
    onWarning: () => undefined,
    onMetrics: () => undefined,
  });

  cancellation.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

test("fetchBackendAuthStatus distinguishes an optional app token from a required one", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [false, true];
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/api\/auth\/status$/);
    return new Response(JSON.stringify({ authRequired: responses.shift() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    assert.equal(await fetchBackendAuthStatus(), false);
    assert.equal(await fetchBackendAuthStatus(), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDocumentStorageHealth preserves actionable Chroma diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    status: "unavailable",
    code: "CHROMA_UNAVAILABLE",
    error: 'ChromaDB is not reachable. Run "docker compose up -d chroma".',
  }), { status: 503, headers: { "Content-Type": "application/json" } });

  try {
    const health = await fetchDocumentStorageHealth();
    assert.equal(health.ok, false);
    assert.equal(health.status, "unavailable");
    assert.equal(health.code, "CHROMA_UNAVAILABLE");
    assert.match(health.error || "", /docker compose up -d chroma/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDocumentStorageHealth reports backend proxy failures instead of mislabeling them as invalid health", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "The Maya API is unavailable. Check that the Express server is running.",
  }), { status: 502, headers: { "Content-Type": "application/json" } });

  try {
    await assert.rejects(
      fetchDocumentStorageHealth(),
      /Maya API is unavailable.*Express server is running/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchModels returns IDs discovered from the configured local provider", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/models\?provider=local$/);
    return new Response(JSON.stringify({
      models: ["google/gemma-4-e4b", "text-embedding-nomic-embed-text-v1.5"],
      defaultModel: "google/gemma-4-e4b",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.deepEqual(await fetchModels(), {
      models: ["google/gemma-4-e4b", "text-embedding-nomic-embed-text-v1.5"],
      defaultModel: "google/gemma-4-e4b",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchModels surfaces local provider unavailability without substituting a model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "LM Studio is unreachable. Start its local server and verify its local endpoint.",
  }), { status: 503, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(fetchModels(), /LM Studio is unreachable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider diagnostics send only provider, model, and inference mode", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; method?: string; body?: string } | undefined;
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), method: init?.method, body: String(init?.body) };
    return new Response(JSON.stringify({
      provider: { id: "openrouter", name: "OpenRouter", local: false },
      configured: true,
      endpoint: "https://openrouter.ai/api/v1",
      models: ["provider/model:free"],
      modelDetails: [{
        id: "provider/model:free",
        name: "Provider Model",
        contextLength: 32768,
        free: true,
      }],
      modelStates: [{
        id: "provider/model:free",
        installed: null,
        available: true,
        verified: false,
        selected: true,
      }],
      verifiedModels: [],
      defaultModel: "",
      server: { status: "connected" },
      authentication: { status: "verified" },
      model: { name: "provider/model:free", status: "available" },
      inference: { status: "not_requested" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await testProviderConnection("openrouter", "provider/model:free");
    assert.equal(captured?.url, "/api/providers/openrouter/test");
    assert.equal(captured?.method, "POST");
    assert.deepEqual(JSON.parse(captured?.body || "{}"), { model: "provider/model:free", inference: false });
    assert.equal(result.server.status, "connected");
    assert.equal(result.model.status, "available");
    assert.deepEqual(result.modelDetails, [{
      id: "provider/model:free",
      name: "Provider Model",
      contextLength: 32768,
      free: true,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat sends the selected provider and model without substitution", async () => {
  let payload: ChatRequest | undefined;
  const events = `data: ${JSON.stringify({ token: "cloud answer" })}\n\ndata: ${JSON.stringify({ done: true })}\n\n`;
  await streamChat({ ...request, provider: "deepseek", model: "deepseek-v4-pro" }, {
    signal: new AbortController().signal,
    fetchImpl: async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as ChatRequest;
      return responseFromChunks([events]);
    },
    onToken: () => undefined,
    onSources: () => undefined,
    onWarning: () => undefined,
    onMetrics: () => undefined,
  });
  assert.equal(payload?.provider, "deepseek");
  assert.equal(payload?.model, "deepseek-v4-pro");
  assert.equal(payload?.useMemory, false);
});

test("memory and response feedback APIs use explicit CRUD and rating requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, method, body });
    if (url.endsWith("/memories") && method === "GET") {
      return new Response(JSON.stringify({ memories: [] }), { status: 200 });
    }
    if (url.endsWith("/feedback") && method === "GET") {
      return new Response(JSON.stringify({ feedback: [] }), { status: 200 });
    }
    if (method === "POST" || method === "PUT") {
      return new Response(JSON.stringify({
        memory: { id: "memory-id", title: "Preference", content: "Short answers", approvedByUser: true },
        feedback: { messageId: "message-id", rating: "positive" },
      }), { status: 201 });
    }
    return new Response(JSON.stringify({ deleted: true }), { status: 200 });
  };
  try {
    await fetchMemories();
    await saveMemory({ title: "Preference", content: "Short answers" });
    await saveMemory({ title: "Preference", content: "Concise answers" }, "memory-id");
    await deleteMemory("memory-id");
    await fetchFeedback();
    await submitFeedback({
      messageId: "3d6c6d18-31c9-4cf5-b0a2-62d3d9b71571",
      conversationId: "e04d2ed8-b996-48a5-b017-73ca4ca30f48",
      rating: "positive",
      provider: "lm-studio",
      model: "local-model",
    });
    await deleteFeedback("3d6c6d18-31c9-4cf5-b0a2-62d3d9b71571");
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "PUT", "DELETE", "GET", "POST", "DELETE"]);
    assert.equal(requests[5].body?.rating, "positive");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
