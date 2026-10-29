import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { SettingsDialog } from "../components/SettingsDialog";
import { DEFAULT_SETTINGS, EMPTY_STATE } from "../lib/storage";
import type { ProviderDiagnostics } from "../lib/types";

test("provider settings render safe configuration, live diagnostics, and explicit test actions", () => {
  const diagnostics: ProviderDiagnostics = {
    provider: { id: "openai", name: "OpenAI", local: false },
    configured: true,
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-test"],
    modelStates: [{
      id: "gpt-test",
      installed: null,
      available: true,
      verified: true,
      selected: true,
    }],
    verifiedModels: ["gpt-test"],
    defaultModel: "",
    server: { status: "connected" },
    authentication: { status: "verified" },
    model: { name: "gpt-test", status: "verified" },
    inference: { status: "passed" },
  };
  const props = {
    open: true,
    state: {
      ...EMPTY_STATE,
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-test" },
    },
    providers: [
      {
        id: "lm-studio",
        name: "LM Studio",
        local: true,
        configured: true,
        enabled: true,
        defaultModel: "google/gemma-4-e4b",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
      {
        id: "openai",
        name: "OpenAI",
        local: false,
        configured: true,
        enabled: true,
        defaultModel: "",
        baseUrl: "https://api.openai.com/v1",
        credentialEnv: "OPENAI_API_KEY",
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        local: false,
        configured: false,
        enabled: true,
        defaultModel: "",
        baseUrl: "https://api.deepseek.com",
        credentialEnv: "DEEPSEEK_API_KEY",
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        local: false,
        configured: false,
        enabled: true,
        defaultModel: "",
        baseUrl: "https://openrouter.ai/api/v1",
        credentialEnv: "OPENROUTER_API_KEY",
      },
    ],
    defaultProvider: "lm-studio",
    authRequired: false,
    models: diagnostics.models,
    modelsBusy: false,
    modelDiscoveryError: "",
    diagnostics,
    providerTestBusy: false,
    memories: [],
    memoryBusy: false,
    memoryError: "",
    onRefreshMemories: () => undefined,
    onSaveMemory: async () => true,
    onDeleteMemory: () => undefined,
    runtimeName: "LM Studio",
    apiToken: "",
    onChangeSetting: () => undefined,
    onRefreshModels: () => undefined,
    onTestConnection: () => undefined,
    onTestInference: () => undefined,
    onTokenChange: () => undefined,
    onSaveToken: () => undefined,
    onClose: () => undefined,
    onClearChats: () => undefined,
    onExportChats: () => undefined,
    onImportChats: () => undefined,
  };
  const html = renderToStaticMarkup(createElement(SettingsDialog, props));

  assert.match(html, /aria-label="Provider endpoint"/);
  assert.match(html, /https:\/\/api\.openai\.com\/v1/);
  assert.match(html, /Server <b>connected<\/b>/);
  assert.match(html, /Authentication <b>verified<\/b>/);
  assert.match(html, /Selected model <b>verified<\/b>/);
  assert.match(html, /1 discovered · 1 verified/);
  assert.match(html, /Test connection/);
  assert.match(html, /Test inference/);
  assert.match(html, /Refresh models/);
  assert.match(html, /DeepSeek · Cloud · Not configured/);
  assert.match(html, /<option value="deepseek">DeepSeek · Cloud · Not configured<\/option>/);
  assert.match(html, /OpenRouter · Cloud · Not configured/);
  assert.match(html, /<option value="openrouter">OpenRouter · Cloud · Not configured<\/option>/);
  assert.match(html, /Cloud credential: OPENAI_API_KEY/);
  assert.match(html, /No backend API token is configured or required/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab" id="settings-tab-preferences"/);
  assert.match(html, /Cloud credentials/);
  assert.match(html, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(html, /password.*OPENAI_API_KEY/);
  assert.match(html, /Save Settings/);

  const invalidDeepSeekHtml = renderToStaticMarkup(createElement(SettingsDialog, {
    ...props,
    state: {
      ...EMPTY_STATE,
      settings: { ...DEFAULT_SETTINGS, provider: "deepseek", model: "" },
    },
    providers: props.providers.map((provider) => provider.id === "deepseek"
      ? { ...provider, credentialStatus: "invalid" as const }
      : provider),
    diagnostics: {
      ...diagnostics,
      provider: { id: "deepseek", name: "DeepSeek", local: false },
      configured: false,
      authentication: { status: "failed" },
      error: {
        code: "PROVIDER_CREDENTIAL_INVALID",
        message: "DeepSeek DEEPSEEK_API_KEY contains invalid characters for an API key.",
      },
    },
  }));
  assert.match(invalidDeepSeekHtml, /DeepSeek · Cloud · Invalid key format/);
  assert.match(invalidDeepSeekHtml, /Invalid key format/);
  assert.match(invalidDeepSeekHtml, /exact key from the official provider dashboard/);

  const openrouterHtml = renderToStaticMarkup(createElement(SettingsDialog, {
    ...props,
    state: {
      ...EMPTY_STATE,
      settings: { ...DEFAULT_SETTINGS, provider: "openrouter", model: "" },
    },
    models: [],
    diagnostics: {
      ...diagnostics,
      provider: { id: "openrouter", name: "OpenRouter", local: false },
      configured: false,
      endpoint: "https://openrouter.ai/api/v1",
      models: [],
      modelStates: [],
      verifiedModels: [],
      server: { status: "not_tested" },
      authentication: { status: "not_configured" },
      model: { name: "", status: "not_selected" },
      inference: { status: "not_requested" },
    },
  }));
  assert.match(openrouterHtml, /OpenRouter is not configured/);
  assert.match(openrouterHtml, /OPENROUTER_API_KEY/);
  assert.match(openrouterHtml, /backend <code>\.env<\/code> file/);
  assert.match(openrouterHtml, /restart Maya with <code>npm run server<\/code>/);

  const openrouterModel = "provider/model:free";
  const openrouterModelDiagnostics: ProviderDiagnostics = {
    ...diagnostics,
    provider: { id: "openrouter", name: "OpenRouter", local: false },
    configured: true,
    endpoint: "https://openrouter.ai/api/v1",
    models: [openrouterModel],
    modelDetails: [{
      id: openrouterModel,
      name: "OpenRouter Model",
      contextLength: 32768,
      free: true,
    }],
    modelStates: [{
      id: openrouterModel,
      installed: null,
      available: true,
      verified: false,
      selected: true,
    }],
    verifiedModels: [],
    server: { status: "connected" },
    authentication: { status: "verified" },
    model: { name: openrouterModel, status: "available" },
    inference: { status: "not_requested" },
  };
  const openrouterCatalogHtml = renderToStaticMarkup(createElement(SettingsDialog, {
    ...props,
    state: {
      ...EMPTY_STATE,
      settings: { ...DEFAULT_SETTINGS, provider: "openrouter", model: openrouterModel },
    },
    providers: props.providers.map((provider) => provider.id === "openrouter"
      ? { ...provider, configured: true }
      : provider),
    models: [openrouterModel],
    diagnostics: openrouterModelDiagnostics,
  }));
  assert.match(openrouterCatalogHtml, /provider\/model:free · available · OpenRouter Model · 32,768 context · free per catalog/);

  const protectedHtml = renderToStaticMarkup(createElement(SettingsDialog, {
    ...props,
    authRequired: true,
  }));
  assert.match(protectedHtml, /Token required/);
  assert.match(protectedHtml, /Enter the token configured on the Maya server/);
  assert.doesNotMatch(protectedHtml, /No backend API token is configured or required/);

  const ollamaDiagnostics: ProviderDiagnostics = {
    provider: { id: "ollama", name: "Ollama", local: true },
    configured: true,
    endpoint: "http://127.0.0.1:11434",
    models: ["custom-model:tag-1", "another-model:latest"],
    modelDetails: [
      { id: "custom-model:tag-1", family: "custom", parameterSize: "4B", sizeBytes: 2147483648 },
      { id: "another-model:latest", family: "another", sizeBytes: 1024 },
    ],
    modelStates: [
      { id: "custom-model:tag-1", installed: true, available: true, verified: false, selected: true },
      { id: "another-model:latest", installed: true, available: true, verified: false, selected: false },
    ],
    verifiedModels: [],
    defaultModel: "",
    server: { status: "connected" },
    authentication: { status: "not_required" },
    model: { name: "custom-model:tag-1", status: "available" },
    inference: { status: "not_requested" },
  };
  const ollamaHtml = renderToStaticMarkup(createElement(SettingsDialog, {
    ...props,
    state: {
      ...EMPTY_STATE,
      settings: { ...DEFAULT_SETTINGS, provider: "ollama", model: "custom-model:tag-1" },
    },
    providers: [{
      id: "ollama",
      name: "Ollama",
      local: true,
      configured: true,
      enabled: true,
      defaultModel: "",
      baseUrl: "http://127.0.0.1:11434",
    }],
    defaultProvider: "ollama",
    models: ollamaDiagnostics.models,
    diagnostics: ollamaDiagnostics,
  }));
  assert.match(ollamaHtml, /2 discovered · 0 verified/);
  assert.match(ollamaHtml, /custom-model:tag-1 · installed/);
  assert.match(ollamaHtml, /another-model:latest · installed/);
  assert.match(ollamaHtml, /custom-model:tag-1 · installed · custom · 4B · 2 GB/);

  const emptyHtml = renderToStaticMarkup(createElement(SettingsDialog, {
    ...props,
    state: {
      ...EMPTY_STATE,
      settings: { ...DEFAULT_SETTINGS, provider: "ollama", model: "" },
    },
    providers: [{
      id: "ollama",
      name: "Ollama",
      local: true,
      configured: true,
      enabled: true,
      defaultModel: "",
      baseUrl: "http://127.0.0.1:11434",
    }],
    defaultProvider: "ollama",
    authRequired: false,
    models: [],
    diagnostics: {
      ...ollamaDiagnostics,
      models: [],
      modelStates: [],
      verifiedModels: [],
      model: { name: "", status: "unavailable" },
      error: { code: "MODEL_NOT_AVAILABLE", message: "Ollama returned no models." },
    },
  }));
  assert.match(emptyHtml, /Ollama is reachable but has no installed models/);

  const loadingHtml = renderToStaticMarkup(createElement(SettingsDialog, {
    ...props,
    modelsBusy: true,
  }));
  assert.match(loadingHtml, /Refreshing…/);
});
