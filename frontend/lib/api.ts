import type {
  DocumentItem,
  FeedbackEntry,
  FeedbackRating,
  GenerationMetrics,
  MemoryEntry,
  ProviderInfo,
  ProviderDiagnostics,
  SourceReference,
  WorkspaceCheckResult,
  WorkspaceEntry,
  WorkspaceInfo,
  WorkspaceProposal,
  WorkspaceSearchMatch,
} from "./types";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || "/api").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 120_000;

function authHeaders(): HeadersInit {
  if (typeof window === "undefined") return {};
  const token = window.sessionStorage.getItem("maya-api-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error || `${fallback} (${response.status})`);
}

export type ChatRequest = {
  provider: string;
  message: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  temperature: number;
  context: number;
  maxTokens: number;
  systemPrompt: string;
  webSearch: boolean;
  useMemory: boolean;
};

export async function streamChat(
  request: ChatRequest,
  handlers: {
    onToken: (token: string) => void;
    onSources: (sources: SourceReference[]) => void;
    onWarning: (warning: string) => void;
    onMetrics: (metrics: GenerationMetrics) => void;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS,
  );
  const abort = () => controller.abort(handlers.signal.reason || new DOMException("Generation stopped", "AbortError"));
  handlers.signal.addEventListener("abort", abort, { once: true });

  try {
    const fetchImpl = handlers.fetchImpl || fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(request),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      if (handlers.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
      if (controller.signal.aborted) throw new Error("Maya request timed out.");
      throw new Error("Maya backend is unavailable. Start the Express server and check its API URL.");
    }

    if (!response.ok) throw await readError(response, "Chat request failed");
    if (!response.body) throw new Error("Streaming is not supported by this browser.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";

      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;

        let payload: {
          token?: unknown;
          sources?: unknown;
          warning?: unknown;
          metrics?: unknown;
          done?: unknown;
          error?: unknown;
        };
        try {
          payload = JSON.parse(data);
        } catch {
          throw new Error("Maya returned an invalid streaming response.");
        }

        if (typeof payload.error === "string") throw new Error(payload.error);
        if (typeof payload.token === "string") handlers.onToken(payload.token);
        if (typeof payload.warning === "string") handlers.onWarning(payload.warning);
        if (payload.metrics && typeof payload.metrics === "object") {
          handlers.onMetrics(payload.metrics as GenerationMetrics);
        }
        if (Array.isArray(payload.sources)) handlers.onSources(payload.sources as SourceReference[]);
        if (payload.done === true) {
          completed = true;
          return;
        }
      }

      if (done) break;
    }

    if (!completed) throw new Error("Maya's response stream ended unexpectedly.");
  } catch (error) {
    if (handlers.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
    if (controller.signal.aborted) throw new Error("Maya request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
    handlers.signal.removeEventListener("abort", abort);
  }
}

export async function fetchProviders(): Promise<{ providers: ProviderInfo[]; defaultProvider: string; authRequired: boolean }> {
  const response = await fetch(`${API_BASE}/providers`, {
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readError(response, "Unable to load model providers");
  const data = await response.json() as { providers?: unknown; defaultProvider?: unknown; authRequired?: unknown };
  if (!Array.isArray(data.providers) || typeof data.defaultProvider !== "string" || typeof data.authRequired !== "boolean") {
    throw new Error("Maya backend returned an invalid provider list.");
  }
  return {
    providers: data.providers.filter((provider): provider is ProviderInfo => {
      if (typeof provider !== "object" || provider === null) return false;
      const item = provider as Partial<ProviderInfo>;
      return typeof item.id === "string" && typeof item.name === "string"
        && typeof item.local === "boolean" && typeof item.configured === "boolean"
        && typeof item.defaultModel === "string"
        && (item.enabled === undefined || typeof item.enabled === "boolean")
        && (item.baseUrl === undefined || typeof item.baseUrl === "string")
        && (item.credentialEnv === undefined || typeof item.credentialEnv === "string")
        && (item.credentialStatus === undefined
          || ["missing", "invalid", "configured"].includes(item.credentialStatus));
    }),
    defaultProvider: data.defaultProvider,
    authRequired: data.authRequired,
  };
}

export async function fetchBackendAuthStatus(): Promise<boolean> {
  const response = await fetch(`${API_BASE}/auth/status`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readError(response, "Unable to check Maya API authentication");
  const data = await response.json() as { authRequired?: unknown };
  if (typeof data.authRequired !== "boolean") {
    throw new Error("Maya backend returned an invalid authentication status.");
  }
  return data.authRequired;
}

export async function testProviderConnection(
  provider: string,
  model = "",
  inference = false,
): Promise<ProviderDiagnostics> {
  const response = await fetch(`${API_BASE}/providers/${encodeURIComponent(provider)}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ ...(model ? { model } : {}), inference }),
    cache: "no-store",
    signal: AbortSignal.timeout(inference ? 125_000 : 15_000),
  });
  if (!response.ok) throw await readError(response, "Provider diagnostic request failed");
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Maya backend returned an invalid provider diagnostic.");
  }
  const data = payload as Partial<ProviderDiagnostics>;
  const isOneOf = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);
  const invalidError = data.error !== undefined && (
    typeof data.error !== "object" || data.error === null
    || typeof data.error.code !== "string" || typeof data.error.message !== "string"
  );
  const invalidModelDetails = data.modelDetails !== undefined && (
    !Array.isArray(data.modelDetails) || data.modelDetails.some((item) => (
      typeof item !== "object" || item === null || typeof item.id !== "string"
      || (item.name !== undefined && typeof item.name !== "string")
      || (item.family !== undefined && typeof item.family !== "string")
      || (item.families !== undefined && (!Array.isArray(item.families)
        || item.families.some((family) => typeof family !== "string")))
      || (item.parameterSize !== undefined && typeof item.parameterSize !== "string")
      || (item.sizeBytes !== undefined && (typeof item.sizeBytes !== "number"
        || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0))
      || (item.contextLength !== undefined && (typeof item.contextLength !== "number"
        || !Number.isSafeInteger(item.contextLength) || item.contextLength < 1))
      || (item.free !== undefined && typeof item.free !== "boolean")
    ))
  );
  if (!data.provider || typeof data.provider.id !== "string" || typeof data.provider.name !== "string"
    || typeof data.provider.local !== "boolean" || typeof data.configured !== "boolean"
    || typeof data.endpoint !== "string" || typeof data.defaultModel !== "string"
    || !Array.isArray(data.models) || data.models.some((value) => typeof value !== "string")
    || !Array.isArray(data.modelStates) || data.modelStates.some((item) => (
      typeof item !== "object" || item === null
      || typeof item.id !== "string" || typeof item.available !== "boolean"
      || typeof item.verified !== "boolean" || typeof item.selected !== "boolean"
      || (item.installed !== null && typeof item.installed !== "boolean")
    ))
    || !Array.isArray(data.verifiedModels) || data.verifiedModels.some((value) => typeof value !== "string")
    || !data.server || !isOneOf(data.server.status, ["not_tested", "connected", "disconnected", "error"])
    || !data.authentication || !isOneOf(data.authentication.status, ["not_required", "not_configured", "not_tested", "verified", "failed"])
    || !data.model || typeof data.model.name !== "string" || !isOneOf(data.model.status, ["not_tested", "not_selected", "available", "verified", "unavailable"])
    || !data.inference || !isOneOf(data.inference.status, ["not_requested", "not_tested", "passed", "failed"])
    || invalidError || invalidModelDetails) {
    throw new Error("Maya backend returned an invalid provider diagnostic.");
  }
  return data as ProviderDiagnostics;
}

export async function fetchModels(provider = "local"): Promise<{ models: string[]; defaultModel: string; provider?: string }> {
  const response = await fetch(`${API_BASE}/models?provider=${encodeURIComponent(provider)}`, {
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readError(response, "Unable to load models");
  const data = await response.json() as { models?: unknown; defaultModel?: unknown };
  if (!Array.isArray(data.models) || typeof data.defaultModel !== "string") {
    throw new Error("Maya backend returned an invalid model list.");
  }
  const responseProvider = (data as { provider?: unknown }).provider;
  return {
    models: data.models.filter((model): model is string => typeof model === "string"),
    defaultModel: data.defaultModel,
    ...(typeof responseProvider === "string" ? { provider: responseProvider } : {}),
  };
}

export async function fetchHealth(provider = "local"): Promise<{ ok: boolean; provider?: string; status: "ready" | "model_missing" | "unavailable" | "timeout"; error?: string }> {
  const response = await fetch(`${API_BASE}/health?provider=${encodeURIComponent(provider)}`, {
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; provider?: string; status?: string; error?: string };
  const status = ["ready", "model_missing", "unavailable", "timeout"].includes(String(data.status))
    ? data.status as "ready" | "model_missing" | "unavailable" | "timeout"
    : "unavailable";
  return {
    ok: response.ok && data.ok === true,
    provider: typeof data.provider === "string" ? data.provider : "Ollama",
    status,
    error: data.error || (!response.ok ? `Maya backend health check failed (${response.status}).` : undefined),
  };
}

export async function fetchDocuments(): Promise<DocumentItem[]> {
  const response = await fetch(`${API_BASE}/documents`, { headers: authHeaders(), cache: "no-store" });
  if (!response.ok) throw await readError(response, "Unable to load documents");
  const data = await response.json() as { documents?: unknown };
  if (!Array.isArray(data.documents)) throw new Error("Maya backend returned an invalid document list.");
  return data.documents as DocumentItem[];
}

export type DocumentStorageHealth = {
  ok: boolean;
  status: "ready" | "unavailable" | "misconfigured" | "initialization_error" | "not_configured";
  code?: string;
  error?: string;
};

export async function fetchDocumentStorageHealth(): Promise<DocumentStorageHealth> {
  const response = await fetch(`${API_BASE}/documents/health`, {
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => ({}));
  const data = typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Partial<DocumentStorageHealth>
    : {};
  const statuses: DocumentStorageHealth["status"][] = [
    "ready",
    "unavailable",
    "misconfigured",
    "initialization_error",
    "not_configured",
  ];
  if (typeof data.ok !== "boolean" || !statuses.includes(data.status as DocumentStorageHealth["status"])) {
    if (!response.ok && typeof data.error === "string" && data.error.trim()) {
      throw new Error(data.error);
    }
    throw new Error(`Maya returned an invalid document storage health response (${response.status}).`);
  }
  return {
    ok: response.ok && data.ok,
    status: data.status as DocumentStorageHealth["status"],
    code: typeof data.code === "string" ? data.code : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
  };
}

export async function uploadDocument(file: File): Promise<DocumentItem> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${API_BASE}/documents`, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
  });
  if (!response.ok) throw await readError(response, "Unable to process document");
  const data = await response.json() as { document?: DocumentItem };
  if (!data.document?.id) throw new Error("Maya backend returned an invalid document response.");
  return data.document;
}

export async function removeDocument(documentId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) throw await readError(response, "Unable to delete document");
}

export async function fetchMemories(query = ""): Promise<MemoryEntry[]> {
  const search = query ? `?q=${encodeURIComponent(query)}` : "";
  const response = await fetch(`${API_BASE}/memories${search}`, {
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readError(response, "Unable to load approved memories");
  const data = await response.json() as { memories?: unknown };
  if (!Array.isArray(data.memories)) throw new Error("Maya returned an invalid memory list.");
  return data.memories as MemoryEntry[];
}

export async function saveMemory(input: { title: string; content: string }, id?: string): Promise<MemoryEntry> {
  const response = await fetch(`${API_BASE}/memories${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readError(response, "Unable to save memory");
  const data = await response.json() as { memory?: MemoryEntry };
  if (!data.memory?.id) throw new Error("Maya returned an invalid memory response.");
  return data.memory;
}

export async function deleteMemory(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/memories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) throw await readError(response, "Unable to delete memory");
}

export async function fetchFeedback(): Promise<FeedbackEntry[]> {
  const response = await fetch(`${API_BASE}/feedback`, {
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readError(response, "Unable to load response feedback");
  const data = await response.json() as { feedback?: unknown };
  if (!Array.isArray(data.feedback)) throw new Error("Maya returned an invalid feedback list.");
  return data.feedback as FeedbackEntry[];
}

export async function submitFeedback(input: {
  messageId: string;
  conversationId: string;
  rating: FeedbackRating;
  provider: string;
  model: string;
}): Promise<FeedbackEntry> {
  const response = await fetch(`${API_BASE}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readError(response, "Unable to save response feedback");
  const data = await response.json() as { feedback?: FeedbackEntry };
  if (!data.feedback?.messageId) throw new Error("Maya returned an invalid feedback response.");
  return data.feedback;
}

export async function deleteFeedback(messageId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/feedback/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) throw await readError(response, "Unable to remove response feedback");
}

async function workspaceRequest<T>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
    cache: "no-store",
    signal: init?.signal || AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await readError(response, "Workspace request failed");
  return response.json() as Promise<T>;
}

export async function fetchWorkspaceInfo(): Promise<WorkspaceInfo> {
  const result = await workspaceRequest<{ workspace: WorkspaceInfo }>("/workspace");
  if (!result.workspace || typeof result.workspace.enabled !== "boolean") {
    throw new Error("Maya returned an invalid workspace status.");
  }
  return result.workspace;
}

export async function fetchWorkspaceFiles(relativePath = "."): Promise<{ path: string; entries: WorkspaceEntry[] }> {
  const query = new URLSearchParams({ path: relativePath });
  const result = await workspaceRequest<{ path: string; entries: WorkspaceEntry[] }>(`/workspace/files?${query}`);
  if (!Array.isArray(result.entries)) throw new Error("Maya returned an invalid workspace file list.");
  return result;
}

export async function fetchWorkspaceFile(relativePath: string): Promise<{ path: string; content: string }> {
  const query = new URLSearchParams({ path: relativePath });
  return workspaceRequest(`/workspace/file?${query}`);
}

export async function searchWorkspace(queryText: string): Promise<{ matches: WorkspaceSearchMatch[]; truncated: boolean }> {
  const query = new URLSearchParams({ q: queryText });
  return workspaceRequest(`/workspace/search?${query}`);
}

export async function createWorkspaceProposal(relativePath: string, content: string): Promise<WorkspaceProposal> {
  const result = await workspaceRequest<{ proposal: WorkspaceProposal }>("/workspace/proposals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: relativePath, content }),
  });
  if (!result.proposal?.id) throw new Error("Maya returned an invalid file proposal.");
  return result.proposal;
}

export async function approveWorkspaceProposal(proposalId: string): Promise<{ applied: boolean; path: string }> {
  return workspaceRequest(`/workspace/proposals/${encodeURIComponent(proposalId)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: true }),
  });
}

export async function runWorkspaceCheck(check: "test" | "lint" | "typecheck" | "build"): Promise<WorkspaceCheckResult> {
  return workspaceRequest("/workspace/checks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ check, approved: true }),
  }, 310_000);
}
