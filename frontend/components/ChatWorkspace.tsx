"use client";

import {
  Check,
  CircleHelp,
  Copy,
  FolderTree,
  Menu,
  MoreHorizontal,
  PanelLeft,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Composer } from "@/components/Composer";
import { MarkdownMessage, MessageMetrics, MessageSources } from "@/components/MarkdownMessage";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Sidebar } from "@/components/Sidebar";
import { WorkspaceDialog } from "@/components/WorkspaceDialog";
import { deleteFeedback, deleteMemory, fetchBackendAuthStatus, fetchDocumentStorageHealth, fetchDocuments, fetchFeedback, fetchMemories, fetchProviders, fetchWorkspaceInfo, removeDocument, saveMemory, streamChat, submitFeedback, testProviderConnection, uploadDocument } from "@/lib/api";
import { createConversation, EMPTY_STATE, makeMessage, normalizeState, STORAGE_KEY } from "@/lib/storage";
import type { ChatMessage, Conversation, DocumentItem, FeedbackRating, GenerationMetrics, MayaSettings, MayaState, MemoryEntry, ProviderDiagnostics, ProviderInfo, SourceReference, WorkspaceInfo } from "@/lib/types";

type Toast = { id: number; message: string; tone: "info" | "error" };
const EMPTY_MODEL_LIST: string[] = [];

function loadInitialData() {
  let state = EMPTY_STATE;
  let storageError = "";
  let apiToken = "";
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) state = normalizeState(JSON.parse(saved));
    } catch (error) {
      storageError = error instanceof Error ? error.message : "Could not read saved Maya history.";
    }
    apiToken = window.sessionStorage.getItem("maya-api-token") || "";
  }
  return { state, storageError, apiToken };
}

function subscribeToHydration() {
  return () => undefined;
}

function getClientHydrationSnapshot() {
  return true;
}

function getServerHydrationSnapshot() {
  return false;
}

function messageTime(timestamp?: string): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ChatWorkspace() {
  const [initialData] = useState(loadInitialData);
  const [state, setState] = useState<MayaState>(initialData.state);
  const [storageError, setStorageError] = useState(initialData.storageError);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [projectNotes, setProjectNotes] = useState("");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [defaultProvider, setDefaultProvider] = useState("local");
  const [backendAuthRequired, setBackendAuthRequired] = useState(false);
  const [providerStateById, setProviderStateById] = useState<Record<string, {
    models: string[];
    diagnostics: ProviderDiagnostics | null;
    error: string;
  }>>({});
  const [modelsBusy, setModelsBusy] = useState(false);
  const [providerTestBusy, setProviderTestBusy] = useState(false);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoryBusy, setMemoryBusy] = useState(true);
  const [memoryError, setMemoryError] = useState("");
  const [feedbackByMessageId, setFeedbackByMessageId] = useState<Record<string, FeedbackRating>>({});
  const [apiToken, setApiToken] = useState(initialData.apiToken);
  const [tokenVersion, setTokenVersion] = useState(0);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [documentsBusy, setDocumentsBusy] = useState(true);
  const [documentsError, setDocumentsError] = useState("");
  const [backendError, setBackendError] = useState("");
  const [backendConnected, setBackendConnected] = useState(false);
  const [runtimeName, setRuntimeName] = useState("Ollama");
  const [backendStatus, setBackendStatus] = useState<"checking" | "ready" | "model_missing" | "not_configured" | "unavailable" | "timeout">("unavailable");
  const [isGenerating, setIsGenerating] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [copyState, setCopyState] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const providerRequestSequence = useRef(0);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hydrated = useSyncExternalStore(subscribeToHydration, getClientHydrationSnapshot, getServerHydrationSnapshot);
  const selectedProviderId = state.settings.provider === "local" ? defaultProvider : state.settings.provider;
  const selectedProviderIdRef = useRef(selectedProviderId);
  const selectedModelRef = useRef(String(state.settings.model || ""));
  const selectedProviderState = providerStateById[selectedProviderId];
  const selectedProviderInfo = providers.find((provider) => provider.id === selectedProviderId);
  const models = selectedProviderState?.models ?? EMPTY_MODEL_LIST;
  const providerDiagnostics = selectedProviderState?.diagnostics || null;
  const modelDiscoveryError = selectedProviderState?.error || "";

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  useEffect(() => {
    selectedProviderIdRef.current = selectedProviderId;
  }, [selectedProviderId]);

  useEffect(() => {
    selectedModelRef.current = String(state.settings.model || "");
  }, [state.settings.model]);

  const refreshProviderStatus = useCallback(async (requestedProvider?: string, modelOverride?: string) => {
    const selectedProvider = requestedProvider
      || selectedProviderIdRef.current;
    const requestSequence = ++providerRequestSequence.current;
    setModelsBusy(true);
    setProviderTestBusy(false);
    if (selectedProvider === selectedProviderIdRef.current) {
      setBackendConnected(false);
      setBackendStatus("checking");
    }
    setBackendError("");
    try {
      let selectedModel = modelOverride ?? selectedModelRef.current;
      const diagnostics = await testProviderConnection(selectedProvider, selectedModel);
      if (requestSequence !== providerRequestSequence.current) return;
      if (!selectedModel && diagnostics.models.includes(diagnostics.defaultModel)) {
        selectedModel = diagnostics.defaultModel;
        if (selectedProvider === selectedProviderIdRef.current) {
          setState((current) => ({ ...current, settings: { ...current.settings, model: selectedModel } }));
        }
      }
      setProviderStateById((current) => ({
        ...current,
        [selectedProvider]: { models: diagnostics.models, diagnostics, error: diagnostics.error?.message || "" },
      }));
      const modelUnavailable = diagnostics.server.status === "connected"
        && !["available", "verified"].includes(diagnostics.model.status);
      const timedOut = diagnostics.error?.code === "TIMEOUT";
      const notConfigured = diagnostics.error?.code === "PROVIDER_NOT_CONFIGURED";
      if (selectedProvider === selectedProviderIdRef.current) {
        setBackendConnected(diagnostics.server.status === "connected" && !modelUnavailable);
        setRuntimeName(diagnostics.provider.name);
        setBackendStatus(notConfigured ? "not_configured" : modelUnavailable ? "model_missing" : timedOut ? "timeout" : diagnostics.server.status === "connected" ? "ready" : "unavailable");
        setBackendError(diagnostics.error?.message || "");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Maya backend health check failed.";
      if (requestSequence !== providerRequestSequence.current) return;
      setProviderStateById((current) => ({
        ...current,
        [selectedProvider]: { models: [], diagnostics: null, error: message },
      }));
      if (selectedProvider === selectedProviderIdRef.current) {
        setBackendConnected(false);
        setBackendStatus("unavailable");
        setBackendError(message);
      }
    } finally {
      if (requestSequence === providerRequestSequence.current) setModelsBusy(false);
    }
  }, []);

  const runProviderTest = useCallback(async (inference: boolean, modelOverride?: string) => {
    const selectedProvider = selectedProviderIdRef.current;
    const requestSequence = ++providerRequestSequence.current;
    setProviderTestBusy(true);
    setModelsBusy(false);
    setBackendConnected(false);
    setBackendStatus("checking");
    setBackendError("");
    try {
      const diagnostics = await testProviderConnection(
        selectedProvider,
        modelOverride ?? selectedModelRef.current,
        inference,
      );
      if (requestSequence !== providerRequestSequence.current) return;
      setProviderStateById((current) => ({
        ...current,
        [selectedProvider]: { models: diagnostics.models, diagnostics, error: diagnostics.error?.message || "" },
      }));
      const unavailable = diagnostics.server.status === "connected"
        && !["available", "verified"].includes(diagnostics.model.status);
      const timedOut = diagnostics.error?.code === "TIMEOUT";
      const notConfigured = diagnostics.error?.code === "PROVIDER_NOT_CONFIGURED";
      if (selectedProvider === selectedProviderIdRef.current) {
        setBackendConnected(diagnostics.server.status === "connected" && !unavailable);
        setRuntimeName(diagnostics.provider.name);
        setBackendStatus(notConfigured ? "not_configured" : unavailable ? "model_missing" : timedOut ? "timeout" : diagnostics.server.status === "connected" ? "ready" : "unavailable");
        setBackendError(diagnostics.error?.message || "");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider diagnostic request failed.";
      if (requestSequence !== providerRequestSequence.current) return;
      setProviderStateById((current) => ({
        ...current,
        [selectedProvider]: { models: [], diagnostics: null, error: message },
      }));
      if (selectedProvider === selectedProviderIdRef.current) {
        setBackendConnected(false);
        setBackendStatus("unavailable");
        setBackendError(message);
      }
    } finally {
      if (requestSequence === providerRequestSequence.current) setProviderTestBusy(false);
    }
  }, []);

  const updateProjectNotes = useCallback((value: string) => {
    const notes = value.slice(0, 4000);
    setProjectNotes(notes);
    if (workspaceInfo?.enabled && workspaceInfo.id) {
      try {
        window.localStorage.setItem(`maya-project-notes:${workspaceInfo.id}`, notes);
      } catch {
        notify("Project notes could not be saved in this browser.", "error");
      }
    }
  }, [notify, workspaceInfo]);

  useEffect(() => {
    if (!hydrated || storageError) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      window.setTimeout(() => {
        setStorageError("Maya could not save history to this browser. Check local storage availability.");
      }, 0);
    }
  }, [state, hydrated, storageError]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    const providerCheck = window.setTimeout(() => {
      void (async () => {
        try {
          setBackendAuthRequired(await fetchBackendAuthStatus());
          const result = await fetchProviders();
          if (!active) return;
          setProviders(result.providers);
          setDefaultProvider(result.defaultProvider);
          setBackendAuthRequired(result.authRequired);
          const currentProvider = selectedProviderIdRef.current;
          const selectedProvider = currentProvider === "local" ? result.defaultProvider : currentProvider;
          if (currentProvider === "local") {
            setState((current) => current.settings.provider === "local"
              ? { ...current, settings: { ...current.settings, provider: result.defaultProvider } }
              : current);
          }
          await refreshProviderStatus(selectedProvider);
        } catch (error) {
          if (active) setBackendError(error instanceof Error ? error.message : "Unable to load model providers.");
        }
      })();
    }, 0);
    fetchWorkspaceInfo().then((info) => {
      if (!active) return;
      setWorkspaceInfo(info);
      setProjectNotes(info.enabled && info.id ? window.localStorage.getItem(`maya-project-notes:${info.id}`) || "" : "");
    }).catch((error: unknown) => {
      if (active) setWorkspaceInfo({ enabled: false });
      if (active) setBackendError(error instanceof Error ? error.message : "Unable to load the configured workspace.");
    });
    void (async () => {
      try {
        const health = await fetchDocumentStorageHealth();
        if (!health.ok) {
          if (active) {
            setDocuments([]);
            setDocumentsError(health.error || `Document storage is ${health.status}.`);
          }
          return;
        }
        const result = await fetchDocuments();
        if (active) {
          setDocuments(result);
          setDocumentsError("");
        }
      } catch (error) {
        if (active) {
          setDocuments([]);
          setDocumentsError(error instanceof Error ? error.message : "Document storage health check failed.");
        }
      } finally {
        if (active) setDocumentsBusy(false);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(providerCheck);
    };
  }, [hydrated, tokenVersion, refreshProviderStatus]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    Promise.all([fetchMemories(), fetchFeedback()])
      .then(([savedMemories, feedback]) => {
        if (!active) return;
        setMemories(savedMemories);
        setFeedbackByMessageId(Object.fromEntries(feedback.map((entry) => [entry.messageId, entry.rating])));
        setMemoryError("");
      })
      .catch((error: unknown) => {
        if (active) setMemoryError(error instanceof Error ? error.message : "Unable to load local learning data.");
      })
      .finally(() => {
        if (active) setMemoryBusy(false);
      });
    return () => {
      active = false;
    };
  }, [hydrated, tokenVersion]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const activeConversation = state.conversations.find((conversation) => conversation.id === state.activeConversationId) || null;
  const visibleConversations = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return state.conversations.filter((conversation) => !term || conversation.title.toLocaleLowerCase().includes(term));
  }, [search, state.conversations]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation?.messages]);

  const updateConversation = useCallback((id: string, update: (conversation: Conversation) => Conversation) => {
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) => conversation.id === id ? update(conversation) : conversation),
    }));
  }, []);

  const startNewChat = useCallback(() => {
    controllerRef.current?.abort();
    const conversation = createConversation();
    setState((current) => ({
      ...current,
      conversations: [conversation, ...current.conversations],
      activeConversationId: conversation.id,
    }));
    setDraft("");
    setSidebarOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        startNewChat();
      }
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startNewChat]);

  const selectConversation = useCallback((id: string) => {
    setState((current) => ({ ...current, activeConversationId: id }));
    setSidebarOpen(false);
  }, []);

  const handleRename = useCallback((conversation: Conversation) => {
    const nextTitle = window.prompt("Rename conversation", conversation.title);
    const title = nextTitle?.trim().slice(0, 80);
    if (!title) return;
    updateConversation(conversation.id, (current) => ({ ...current, title }));
  }, [updateConversation]);

  const handleDelete = useCallback((conversation: Conversation) => {
    if (!window.confirm(`Delete "${conversation.title}"? This cannot be undone.`)) return;
    if (state.activeConversationId === conversation.id) controllerRef.current?.abort();
    setState((current) => {
      const conversations = current.conversations.filter((item) => item.id !== conversation.id);
      const activeConversationId = current.activeConversationId === conversation.id
        ? conversations[0]?.id ?? null
        : current.activeConversationId;
      return { ...current, conversations, activeConversationId };
    });
  }, [state.activeConversationId]);

  const sendMessage = useCallback(async (overrideText?: string, targetId?: string, priorMessages?: ChatMessage[]) => {
    if (controllerRef.current) return;
    const message = (overrideText ?? draft).trim();
    if (!message) return;
    const conversation = state.conversations.find((item) => item.id === (targetId || state.activeConversationId)) || createConversation();

    const baseMessages = priorMessages ?? conversation.messages;
    const userMessage = makeMessage("user", message);
    const assistantMessage: ChatMessage = { ...makeMessage("assistant", ""), generating: true };
    const pendingConversation: Conversation = {
      ...conversation,
      title: conversation.messages.length === 0 ? message.slice(0, 40) : conversation.title,
      messages: [...baseMessages, userMessage, assistantMessage],
      updatedAt: new Date().toISOString(),
    };
    setState((current) => {
      const exists = current.conversations.some((item) => item.id === conversation.id);
      return {
        ...current,
        conversations: exists
          ? current.conversations.map((item) => item.id === conversation.id ? pendingConversation : item)
          : [pendingConversation, ...current.conversations],
        activeConversationId: exists ? current.activeConversationId : conversation.id,
      };
    });
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsGenerating(true);
    setBackendError("");
    const controller = new AbortController();
    controllerRef.current = controller;
    const history = baseMessages.slice(-10).map(({ role, content }) => ({ role, content: content.slice(-4000) }));
    const selectedProvider = state.settings.provider === "local" ? defaultProvider : state.settings.provider;
    const providerInfo = providers.find((provider) => provider.id === selectedProvider);

    try {
      await streamChat({
        message,
        provider: selectedProvider,
        conversation: history,
        model: String(state.settings.model || ""),
        temperature: Number(state.settings.temperature) || 0,
        context: Number(state.settings.context) || 2048,
        maxTokens: Number(state.settings.maxTokens) || 2048,
        systemPrompt: [
          String(state.settings.systemPrompt || "").trim(),
          providerInfo?.local && projectNotes.trim() ? `Project notes (user-provided context):\n${projectNotes.trim()}` : "",
        ].filter(Boolean).join("\n\n").slice(0, 4000),
        webSearch: Boolean(state.settings.webSearch),
        useMemory: Boolean(state.settings.useMemory),
      }, {
        signal: controller.signal,
        onToken: (token) => updateConversation(conversation.id, (current) => ({
          ...current,
          messages: current.messages.map((item) => item.id === assistantMessage.id ? { ...item, content: item.content + token } : item),
        })),
        onSources: (sources: SourceReference[]) => updateConversation(conversation.id, (current) => ({
          ...current,
          messages: current.messages.map((item) => item.id === assistantMessage.id ? { ...item, sources } : item),
        })),
        onWarning: (warning) => notify(warning, "error"),
        onMetrics: (metrics: GenerationMetrics) => updateConversation(conversation.id, (current) => ({
          ...current,
          messages: current.messages.map((item) => item.id === assistantMessage.id ? { ...item, metrics } : item),
        })),
      });
      updateConversation(conversation.id, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: current.messages.map((item) => item.id === assistantMessage.id ? { ...item, generating: false } : item),
      }));
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      const errorText = error instanceof Error ? error.message : "The local model request failed.";
      updateConversation(conversation.id, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: current.messages.map((item) => item.id === assistantMessage.id
          ? {
            ...item,
            content: stopped
              ? `${item.content}${item.content ? "\n\n" : ""}[Generation stopped]`
              : `Error: ${errorText}`,
            generating: false,
          }
          : item),
      }));
      if (!stopped) notify(errorText, "error");
    } finally {
      controllerRef.current = null;
      setIsGenerating(false);
    }
  }, [defaultProvider, draft, notify, projectNotes, providers, state.activeConversationId, state.conversations, state.settings, updateConversation]);

  const regenerate = useCallback(() => {
    if (!activeConversation || controllerRef.current) return;
    const lastUserIndex = activeConversation.messages.map((message) => message.role).lastIndexOf("user");
    if (lastUserIndex < 0 || lastUserIndex === activeConversation.messages.length - 1) return;
    const prompt = activeConversation.messages[lastUserIndex].content;
    const previous = activeConversation.messages.slice(0, lastUserIndex);
    updateConversation(activeConversation.id, (current) => ({ ...current, messages: previous }));
    void sendMessage(prompt, activeConversation.id, previous);
  }, [activeConversation, sendMessage, updateConversation]);

  const changeSetting = useCallback(<K extends keyof MayaSettings>(key: K, value: MayaSettings[K]) => {
    if (key === "theme") {
      setState((current) => ({ ...current, theme: value === "light" ? "light" : "dark" }));
      return;
    }
    setState((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));
  }, []);

  const selectProvider = useCallback((providerId: string) => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider || provider.enabled === false) return;
    selectedProviderIdRef.current = providerId;
    setBackendConnected(false);
    setBackendStatus("unavailable");
    setRuntimeName(provider.name);
    setBackendError("");
    const providerState = providerStateById[providerId];
    const previousSelection = providerState?.diagnostics?.model.name;
    const retainedSelection = previousSelection && providerState?.models.includes(previousSelection)
      ? previousSelection
      : provider.defaultModel || "";
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        provider: providerId,
        model: retainedSelection,
      },
    }));
    void refreshProviderStatus(providerId, retainedSelection);
  }, [providerStateById, providers, refreshProviderStatus]);

  const selectModel = useCallback((model: string) => {
    if (!models.includes(model)) return;
    selectedModelRef.current = model;
    setState((current) => ({ ...current, settings: { ...current.settings, model } }));
    void runProviderTest(false, model);
  }, [models, runProviderTest]);

  const toggleTheme = useCallback(() => {
    setState((current) => ({ ...current, theme: current.theme === "dark" ? "light" : "dark" }));
  }, []);

  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);

  const saveToken = useCallback(() => {
    setDocumentsBusy(true);
    if (apiToken) window.sessionStorage.setItem("maya-api-token", apiToken);
    else window.sessionStorage.removeItem("maya-api-token");
    setTokenVersion((version) => version + 1);
    notify("Backend token updated for this tab.");
  }, [apiToken, notify]);

  const refreshDocuments = useCallback(async () => {
    setDocumentsBusy(true);
    try {
      const health = await fetchDocumentStorageHealth();
      if (!health.ok) {
        setDocuments([]);
        setDocumentsError(health.error || `Document storage is ${health.status}.`);
        return;
      }
      setDocuments(await fetchDocuments());
      setDocumentsError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load private documents.";
      setDocuments([]);
      setDocumentsError(message);
      notify(message, "error");
    } finally {
      setDocumentsBusy(false);
    }
  }, [notify]);

  const handleUpload = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setDocumentsBusy(true);
    try {
      await uploadDocument(file);
      await refreshDocuments();
      notify(`${file.name} added to private documents.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to process this document.", "error");
    } finally {
      setDocumentsBusy(false);
    }
  }, [notify, refreshDocuments]);

  const refreshMemories = useCallback(async () => {
    setMemoryBusy(true);
    try {
      setMemories(await fetchMemories());
      setMemoryError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load approved memories.";
      setMemoryError(message);
      notify(message, "error");
    } finally {
      setMemoryBusy(false);
    }
  }, [notify]);

  const handleSaveMemory = useCallback(async (input: { title: string; content: string }, id?: string) => {
    setMemoryBusy(true);
    try {
      const memory = await saveMemory(input, id);
      setMemories((current) => id
        ? current.map((item) => item.id === id ? memory : item)
        : [memory, ...current]);
      setMemoryError("");
      notify(id ? "Approved memory updated." : "Memory saved with your approval.");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save this memory.";
      setMemoryError(message);
      notify(message, "error");
      return false;
    } finally {
      setMemoryBusy(false);
    }
  }, [notify]);

  const handleDeleteMemory = useCallback(async (id: string) => {
    const memory = memories.find((item) => item.id === id);
    if (!memory || !window.confirm(`Delete the approved memory "${memory.title}"?`)) return;
    setMemoryBusy(true);
    try {
      await deleteMemory(id);
      setMemories((current) => current.filter((item) => item.id !== id));
      setMemoryError("");
      notify("Memory deleted.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete this memory.";
      setMemoryError(message);
      notify(message, "error");
    } finally {
      setMemoryBusy(false);
    }
  }, [memories, notify]);

  const rateResponse = useCallback(async (conversationId: string, message: ChatMessage, rating: FeedbackRating) => {
    try {
      if (feedbackByMessageId[message.id] === rating) {
        await deleteFeedback(message.id);
        setFeedbackByMessageId((current) => {
          const next = { ...current };
          delete next[message.id];
          return next;
        });
        notify("Response feedback removed.");
        return;
      }
      const feedback = await submitFeedback({
        messageId: message.id,
        conversationId,
        rating,
        provider: message.metrics?.provider || (state.settings.provider === "local" ? defaultProvider : state.settings.provider),
        model: message.metrics?.model || String(state.settings.model),
      });
      setFeedbackByMessageId((current) => ({ ...current, [feedback.messageId]: feedback.rating }));
      notify("Feedback saved. It will not change model weights or be used as training data.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to save feedback.", "error");
    }
  }, [defaultProvider, feedbackByMessageId, notify, state.settings.model, state.settings.provider]);

  const handleDeleteDocument = useCallback(async (document: DocumentItem) => {
    if (!window.confirm(`Delete "${document.fileName}" and its indexed passages?`)) return;
    try {
      await removeDocument(document.id);
      await refreshDocuments();
      notify("Document deleted.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to delete this document.", "error");
    }
  }, [notify, refreshDocuments]);

  const copyResponse = useCallback(async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopyState(message.id);
      window.setTimeout(() => setCopyState(""), 1500);
    } catch {
      notify("Unable to copy the response. Check clipboard permissions.", "error");
    }
  }, [notify]);

  const clearCurrentChat = useCallback(() => {
    if (!activeConversation) return;
    if (!window.confirm(`Clear all messages in "${activeConversation.title}"?`)) return;
    controllerRef.current?.abort();
    updateConversation(activeConversation.id, (current) => ({
      ...current,
      title: "Cleared chat",
      messages: [],
      updatedAt: new Date().toISOString(),
    }));
  }, [activeConversation, updateConversation]);

  const clearAllChats = useCallback(() => {
    if (!window.confirm("Delete all saved conversations? This cannot be undone.")) return;
    controllerRef.current?.abort();
    setState((current) => ({ ...current, conversations: [], activeConversationId: null }));
    setSettingsOpen(false);
  }, []);

  const exportChats = useCallback(() => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "maya-chats.json";
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Chat history exported.");
  }, [notify, state]);

  const importChats = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      const imported = normalizeState(JSON.parse(await file.text()));
      if (!window.confirm(`Import ${imported.conversations.length} conversations and replace the conversations currently in this browser?`)) return;
      setState((current) => ({
        ...current,
        conversations: imported.conversations,
        activeConversationId: imported.activeConversationId,
        settings: imported.settings,
        theme: imported.theme,
      }));
      setSettingsOpen(false);
      notify("Chat history imported.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "This is not a valid Maya history file.", "error");
    }
  }, [notify]);

  const showWelcome = !activeConversation || activeConversation.messages.length === 0;
  if (!hydrated) {
    return <main className="loading-screen" aria-label="Loading Maya"><span className="loading-mark">✦</span><p>Opening your workspace…</p></main>;
  }

  return (
    <main className={`app-root theme-${state.theme}`} data-font-size={String(state.settings.fontSize || "medium")}>
      <Sidebar
        state={state}
        conversations={visibleConversations}
        activeId={state.activeConversationId}
        search={search}
        isOpen={sidebarOpen}
        documents={documents}
        documentsBusy={documentsBusy}
        documentsError={documentsError}
        collapsed={sidebarCollapsed}
        onSearch={setSearch}
        onNewChat={startNewChat}
        onSelect={selectConversation}
        onRename={handleRename}
        onDelete={handleDelete}
        onSettings={() => setSettingsOpen(true)}
        onTheme={toggleTheme}
        onClose={() => setSidebarOpen(false)}
        onToggleCollapse={() => setSidebarCollapsed((collapsed) => !collapsed)}
        onUpload={handleUpload}
        onRefreshDocuments={() => void refreshDocuments()}
        onDeleteDocument={(document) => void handleDeleteDocument(document)}
      />
      {workspaceOpen && <WorkspaceDialog
        open={workspaceOpen}
        onClose={closeWorkspace}
        projectNotes={projectNotes}
        onProjectNotesChange={updateProjectNotes}
      />}

      <section className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            <button type="button" className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open conversation sidebar"><Menu size={19} /></button>
            {sidebarCollapsed && <button type="button" className="icon-button desktop-open" onClick={() => setSidebarCollapsed(false)} aria-label="Expand conversation sidebar"><PanelLeft size={18} /></button>}
            <div className="chat-title">
              <strong>{activeConversation?.title || "Maya"}</strong>
              <span className={`connection-status ${backendConnected ? "connected" : ""}`}><i />{selectedProviderInfo?.credentialStatus === "invalid" ? `${selectedProviderInfo.name} key format invalid` : selectedProviderInfo && !selectedProviderInfo.configured ? `${selectedProviderInfo.name} not configured` : backendStatus === "checking" ? `${runtimeName} checking` : backendStatus === "ready" ? `${runtimeName} ready` : backendStatus === "not_configured" ? `${runtimeName} not configured` : backendStatus === "model_missing" ? runtimeName === "Ollama" ? "Model not installed" : "Model not loaded" : backendStatus === "timeout" ? `${runtimeName} timed out` : `${runtimeName} unavailable`}</span>
            </div>
          </div>
          <div className="topbar-actions">
            <button type="button" className="topbar-button workspace-open-button" onClick={() => setWorkspaceOpen(true)} aria-label="Open coding workspace tools">
              <FolderTree size={15} /><span>{workspaceInfo?.enabled ? workspaceInfo.name : "Workspace"}</span>
            </button>
            {activeConversation?.messages.length ? (
              <button type="button" className="topbar-button" onClick={clearCurrentChat}><Trash2 size={15} /><span>Clear chat</span></button>
            ) : null}
            <div className="model-switcher" aria-label="Active AI model controls">
              <span className={`model-switcher-status ${backendConnected ? "connected" : backendStatus === "timeout" || backendStatus === "model_missing" ? "error" : selectedProviderInfo && !selectedProviderInfo.configured || backendStatus === "not_configured" ? "warning" : ""}`} role="status">
                <i />{selectedProviderInfo?.credentialStatus === "invalid" ? "Invalid key format" : selectedProviderInfo && !selectedProviderInfo.configured ? "Not configured" : backendStatus === "checking" ? "Checking…" : backendStatus === "ready" ? "Connected" : backendStatus === "not_configured" ? "Not configured" : backendStatus === "timeout" ? "Timed out" : backendStatus === "model_missing" ? "Model unavailable" : backendConnected ? "Connected" : "Disconnected"}
              </span>
              <label className="visually-hidden" htmlFor="chat-provider-select">AI provider</label>
              <select
                id="chat-provider-select"
                aria-label="AI provider"
                value={selectedProviderId}
                disabled={isGenerating || !providers.length}
                onChange={(event) => selectProvider(event.target.value)}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id} disabled={provider.enabled === false}>
                    {provider.name}{provider.local ? " · Local" : provider.credentialStatus === "invalid" ? " · Invalid key format" : !provider.configured ? " · Not configured" : provider.enabled === false ? " · Disabled" : ""}
                  </option>
                ))}
              </select>
              <label className="visually-hidden" htmlFor="chat-model-select">AI model</label>
              <select
                id="chat-model-select"
                aria-label="AI model"
                value={String(state.settings.model || "")}
                disabled={modelsBusy || isGenerating || !models.length}
                onChange={(event) => selectModel(event.target.value)}
              >
                {!String(state.settings.model || "") && <option value="">Select a model</option>}
                {String(state.settings.model || "") && !models.includes(String(state.settings.model)) && (
                  <option value={String(state.settings.model)} disabled>{String(state.settings.model)} · unavailable</option>
                )}
                {models.map((model) => {
                  const modelState = providerDiagnostics?.modelStates.find((item) => item.id === model);
                  const modelDetails = providerDiagnostics?.modelDetails?.find((item) => item.id === model);
                  const suffix = [
                    modelState?.verified ? "verified" : modelState?.installed ? "installed" : "available",
                    modelDetails?.free === true ? "free per catalog" : undefined,
                  ].filter(Boolean).join(" · ");
                  return <option key={`${selectedProviderId}:${model}`} value={model}>{model} · {suffix}</option>;
                })}
              </select>
              <button
                type="button"
                className="model-switcher-action"
                aria-label="Refresh available models"
                title="Refresh models"
                disabled={modelsBusy || providerTestBusy || isGenerating}
                onClick={() => void refreshProviderStatus(selectedProviderId, String(state.settings.model || ""))}
              >
                <RefreshCw size={14} className={modelsBusy ? "spin" : ""} />
              </button>
              <button
                type="button"
                className="model-switcher-action model-test-action"
                disabled={!models.includes(String(state.settings.model || "")) || modelsBusy || providerTestBusy || isGenerating}
                onClick={() => void runProviderTest(true)}
              >
                {providerTestBusy ? "Testing…" : "Test model"}
              </button>
            </div>
          </div>
        </header>

        {(backendError || storageError || documentsError) && (
          <div className="error-banner" role="status">
            <CircleHelp size={16} />
            <span>{storageError || backendError || documentsError}</span>
            {!backendConnected && <>
              <button type="button" disabled={modelsBusy} onClick={() => void refreshProviderStatus()}>
                {modelsBusy ? "Checking…" : "Retry connection"}
              </button>
              <button type="button" onClick={() => setSettingsOpen(true)}>Settings</button>
            </>}
          </div>
        )}

        <div className="conversation-content">
          {showWelcome ? (
            <div className="welcome-screen">
              <div className="welcome-glyph"><Sparkles size={25} /></div>
              <p className="eyebrow">YOUR PRIVATE AI WORKSPACE</p>
              <h1>What can I help you with?</h1>
              <p className="welcome-subtitle">A thoughtful assistant, running on your own terms.</p>
              <div className="suggestion-grid">
                {[
                  ["Explain a concept", "Explain a complex idea in simple terms"],
                  ["Help me write", "Help me write a clear and thoughtful message"],
                  ["Work through an idea", "Help me think through an idea step by step"],
                  ["Explore my documents", "Summarize the key ideas in my uploaded documents"],
                ].map(([label, prompt]) => (
                  <button type="button" key={label} className="suggestion-card" onClick={() => void sendMessage(prompt)}>
                    <span>{label}</span><small>{prompt}</small>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages-area" aria-label="Conversation messages" aria-live="polite">
              {activeConversation?.messages.map((message, index) => {
                const isLastAssistant = index === activeConversation.messages.length - 1 && message.role === "assistant";
                return (
                  <article className={`message-row message-${message.role}`} key={message.id}>
                    <div className="message-avatar" aria-hidden="true">{message.role === "assistant" ? <span>✦</span> : "Y"}</div>
                    <div className="message-main">
                      <div className="message-heading"><strong>{message.role === "assistant" ? "Maya" : "You"}</strong><time>{messageTime(message.timestamp)}</time></div>
                      {message.generating && !message.content ? (
                        <div className="thinking" role="status"><span /><span /><span /> Maya is thinking</div>
                      ) : (
                        <MarkdownMessage content={message.content} />
                      )}
                      <MessageSources sources={message.sources} />
                      <MessageMetrics metrics={message.metrics} />
                      {message.role === "assistant" && (
                        <div className="message-actions">
                          {!message.generating && message.content && !message.content.startsWith("Error:") && (
                            <>
                              <button type="button" aria-pressed={feedbackByMessageId[message.id] === "positive"} onClick={() => void rateResponse(activeConversation.id, message, "positive")} aria-label={feedbackByMessageId[message.id] === "positive" ? "Remove helpful feedback" : "Mark response helpful"}>
                                <ThumbsUp size={14} />{feedbackByMessageId[message.id] === "positive" ? "Helpful" : "Helpful?"}
                              </button>
                              <button type="button" aria-pressed={feedbackByMessageId[message.id] === "negative"} onClick={() => void rateResponse(activeConversation.id, message, "negative")} aria-label={feedbackByMessageId[message.id] === "negative" ? "Remove not helpful feedback" : "Mark response not helpful"}>
                                <ThumbsDown size={14} />{feedbackByMessageId[message.id] === "negative" ? "Not helpful" : "Not helpful?"}
                              </button>
                            </>
                          )}
                          <button type="button" onClick={() => void copyResponse(message)} aria-label="Copy response">
                            {copyState === message.id ? <Check size={14} /> : <Copy size={14} />}
                            {copyState === message.id ? "Copied" : "Copy"}
                          </button>
                          {isLastAssistant && !message.generating && <button type="button" onClick={regenerate}><MoreHorizontal size={14} /> Regenerate</button>}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
              <div ref={messageEndRef} />
            </div>
          )}
        </div>

        <Composer
          value={draft}
          isGenerating={isGenerating}
          webSearch={Boolean(state.settings.webSearch)}
          onChange={setDraft}
          onSend={() => void sendMessage()}
          onStop={() => controllerRef.current?.abort()}
          onToggleWebSearch={() => changeSetting("webSearch", !state.settings.webSearch)}
          onUpload={handleUpload}
        />
      </section>

      {toast && <div className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>{toast.message}</div>}
      {storageError && <button type="button" className="storage-retry" onClick={() => {
        setStorageError("");
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
          setStorageError("Maya could not save history to this browser.");
        }
      }}>Retry saving history</button>}

      <SettingsDialog
        open={settingsOpen}
        state={state}
        providers={providers}
        defaultProvider={defaultProvider}
        authRequired={backendAuthRequired}
        models={models}
        modelsBusy={modelsBusy}
        modelDiscoveryError={modelDiscoveryError}
        diagnostics={providerDiagnostics}
        providerTestBusy={providerTestBusy}
        memories={memories}
        memoryBusy={memoryBusy}
        memoryError={memoryError}
        onRefreshMemories={() => void refreshMemories()}
        onSaveMemory={handleSaveMemory}
        onDeleteMemory={(id) => void handleDeleteMemory(id)}
        runtimeName={runtimeName}
        apiToken={apiToken}
        onChangeSetting={(key, value) => {
          if (key === "provider" && typeof value === "string") {
            selectProvider(value);
            return;
          }
          if (key === "model" && typeof value === "string") {
            selectModel(value);
            return;
          }
          changeSetting(key, value);
        }}
        onRefreshModels={() => void refreshProviderStatus()}
        onTestConnection={() => void runProviderTest(false)}
        onTestInference={() => void runProviderTest(true)}
        onTokenChange={setApiToken}
        onSaveToken={saveToken}
        onClose={() => setSettingsOpen(false)}
        onClearChats={clearAllChats}
        onExportChats={exportChats}
        onImportChats={(file) => void importChats(file)}
      />
    </main>
  );
}
