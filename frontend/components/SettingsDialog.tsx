"use client";

import { useEffect, useState } from "react";
import { Activity, KeyRound, Pencil, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { MayaSettings, MayaState, MemoryEntry, ProviderDiagnostics, ProviderInfo } from "@/lib/types";

function formatModelSize(sizeBytes?: number): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = sizeBytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${Number(size.toFixed(1))} ${units[unitIndex]}`;
}

type Props = {
  open: boolean;
  state: MayaState;
  providers: ProviderInfo[];
  defaultProvider: string;
  authRequired: boolean;
  models: string[];
  modelsBusy: boolean;
  modelDiscoveryError: string;
  diagnostics: ProviderDiagnostics | null;
  providerTestBusy: boolean;
  memories: MemoryEntry[];
  memoryBusy: boolean;
  memoryError: string;
  onRefreshMemories: () => void;
  onSaveMemory: (input: { title: string; content: string }, id?: string) => Promise<boolean>;
  onDeleteMemory: (id: string) => void;
  runtimeName: string;
  apiToken: string;
  onChangeSetting: <K extends keyof MayaSettings>(key: K, value: MayaSettings[K]) => void;
  onRefreshModels: () => void;
  onTestConnection: () => void;
  onTestInference: () => void;
  onTokenChange: (value: string) => void;
  onSaveToken: () => void;
  onClose: () => void;
  onClearChats: () => void;
  onExportChats: () => void;
  onImportChats: (file: File | undefined) => void;
};

export function SettingsDialog({
  open,
  state,
  providers,
  defaultProvider,
  authRequired,
  models,
  modelsBusy,
  modelDiscoveryError,
  diagnostics,
  providerTestBusy,
  memories,
  memoryBusy,
  memoryError,
  onRefreshMemories,
  onSaveMemory,
  onDeleteMemory,
  runtimeName,
  apiToken,
  onChangeSetting,
  onRefreshModels,
  onTestConnection,
  onTestInference,
  onTokenChange,
  onSaveToken,
  onClose,
  onClearChats,
  onExportChats,
  onImportChats,
}: Props) {
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<"providers" | "preferences" | "data">("providers");
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;
  const settings = state.settings;
  const selectedProvider = settings.provider === "local" ? defaultProvider : settings.provider;
  const selectedProviderInfo = providers.find((provider) => provider.id === selectedProvider);

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="dialog-header">
          <div><p className="eyebrow">MAYA AI · WORKSPACE</p><h2 id="settings-title">Settings</h2><p className="settings-subtitle">Configure your assistant, providers, and local data.</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings"><X size={19} /></button>
        </header>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          <button type="button" role="tab" id="settings-tab-providers" aria-selected={activeSection === "providers"} aria-controls="settings-panel" onClick={() => setActiveSection("providers")}><Activity size={15} /> Providers</button>
          <button type="button" role="tab" id="settings-tab-preferences" aria-selected={activeSection === "preferences"} aria-controls="settings-panel" onClick={() => setActiveSection("preferences")}><SlidersHorizontal size={15} /> Preferences</button>
          <button type="button" role="tab" id="settings-tab-data" aria-selected={activeSection === "data"} aria-controls="settings-panel" onClick={() => setActiveSection("data")}><KeyRound size={15} /> Data &amp; memory</button>
        </div>

        {activeSection === "providers" && <div className="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby="settings-tab-providers">
        <div className="settings-section-heading">
          <div><h3>AI providers</h3><p>Choose an inference provider and inspect its live connection.</p></div>
          <span className={`status-pill ${selectedProviderInfo?.credentialStatus === "invalid" ? "status-bad" : !selectedProviderInfo?.configured ? "state-warning" : diagnostics?.server.status === "connected" ? "status-good" : diagnostics?.server.status === "disconnected" || diagnostics?.server.status === "error" ? "status-bad" : "status-neutral"}`}><i />{selectedProviderInfo?.credentialStatus === "invalid" ? "Invalid key format" : !selectedProviderInfo?.configured ? "Not configured" : diagnostics?.server.status === "connected" ? "Connected" : diagnostics?.server.status === "disconnected" ? "Disconnected" : diagnostics?.server.status === "error" ? "Error" : "Not tested"}</span>
        </div>
        <div className="settings-grid">
          <div className="field">
            <span>Provider</span>
            <select value={selectedProvider} onChange={(event) => onChangeSetting("provider", event.target.value)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={provider.enabled === false}>
                    {provider.name} · {provider.local ? "Local" : provider.credentialStatus === "invalid" ? "Cloud · Invalid key format" : !provider.configured ? "Cloud · Not configured" : provider.enabled === false ? "Cloud · Disabled" : "Cloud · configured"}
                </option>
              ))}
            </select>
            <p className="setting-note">
              {selectedProviderInfo?.local
                ? `${runtimeName} runs locally. No cloud API key is required; prompts are sent only to this local provider.`
                : `${selectedProviderInfo?.name || "Cloud provider"} · cloud inference. Your prompt and conversation are sent to the selected provider. Maya does not send local documents or project notes.`}
            </p>
            {selectedProviderInfo?.credentialEnv && selectedProviderInfo.credentialStatus === "invalid" && (
              <p className="setting-note" role="alert">
                {selectedProviderInfo.name} has an invalid API key format. Replace the value of <code>{selectedProviderInfo.credentialEnv}</code> in the backend <code>.env</code> with the exact key from the official provider dashboard, then restart Maya. The key stays server-side.
              </p>
            )}
            {selectedProviderInfo?.credentialEnv && !selectedProviderInfo.configured && selectedProviderInfo.credentialStatus !== "invalid" && (
              <p className="setting-note" role="status">
                {selectedProviderInfo.name} is not configured. Set <code>{selectedProviderInfo.credentialEnv}</code> in the backend <code>.env</code> file, then restart Maya with <code>npm run server</code>. Local providers do not require cloud API keys.
              </p>
            )}
          </div>
          <div className="field field-wide">
            <span>Provider endpoint</span>
            <input aria-label="Provider endpoint" readOnly value={selectedProviderInfo?.baseUrl || diagnostics?.endpoint || "Configured by the backend"} />
            <small>
              {selectedProviderInfo?.credentialEnv
                ? `Cloud credential: ${selectedProviderInfo.credentialEnv}. Set it in the backend .env file. Keys stay server-side and are never stored in this browser.`
                : selectedProviderInfo?.local
                  ? `Configure ${selectedProvider === "lm-studio" ? "LM_STUDIO_BASE_URL" : "OLLAMA_URL"} in the backend .env file, then restart the API.`
                  : "The backend owns this provider endpoint."}
            </small>
          </div>
          <div className="field field-wide provider-diagnostics" aria-live="polite">
            <span className="diagnostic-heading">Connection diagnostics <small>{diagnostics?.provider.name || selectedProviderInfo?.name || "Provider"} · {diagnostics?.provider.local ? "Local" : diagnostics?.configured ? "Configured" : "Not configured"}</small></span>
            <div className="provider-diagnostic-grid">
              <span>Server <b>{diagnostics?.server.status || "Not tested"}</b></span>
              <span>Authentication <b>{diagnostics?.authentication.status || "Not tested"}</b></span>
              <span>Selected model <b>{diagnostics?.model.status === "available" ? "available · not inference-tested" : diagnostics?.model.status || "Not tested"}</b></span>
              <span>Inference <b>{diagnostics?.inference.status || "Not tested"}</b></span>
            </div>
            {diagnostics?.error?.message && <small role="alert">{diagnostics.error.message}</small>}
            <div className="provider-test-actions">
              <button type="button" className="secondary-button" disabled={modelsBusy || providerTestBusy} onClick={onTestConnection}>
                {providerTestBusy ? "Testing…" : diagnostics?.server.status === "disconnected" || diagnostics?.server.status === "error" ? "Retry connection" : "Test connection"}
              </button>
              <button type="button" className="secondary-button" disabled={modelsBusy || providerTestBusy || !models.includes(String(settings.model))} onClick={onTestInference}>
                {providerTestBusy ? "Testing…" : "Test inference"}
              </button>
              <button type="button" className="secondary-button" disabled={modelsBusy || providerTestBusy} onClick={onRefreshModels}>
                {modelsBusy ? "Refreshing…" : "Refresh models"}
              </button>
            </div>
          </div>
          <label className="field">
            <span>{selectedProviderInfo?.local ? "Local model" : "Cloud model"} <small>{modelsBusy
              ? "Discovering models…"
              : `${models.length} discovered · ${diagnostics?.verifiedModels.length || 0} verified`}</small></span>
            <select aria-label={`${selectedProviderInfo?.name || "Provider"} model`} value={String(settings.model)} onChange={(event) => onChangeSetting("model", event.target.value)}>
              {!String(settings.model) && <option value="">Select a model</option>}
              {String(settings.model) && !models.includes(String(settings.model)) && <option value={String(settings.model)} disabled>{String(settings.model)} (not in discovered list)</option>}
              {models.map((model) => {
                const modelState = diagnostics?.modelStates.find((item) => item.id === model);
                const modelDetails = diagnostics?.modelDetails?.find((item) => item.id === model);
                const status = modelState?.verified
                  ? "verified"
                  : modelState?.installed === true ? "installed" : modelState?.available ? "available" : "not checked";
                const family = modelDetails?.family || modelDetails?.families?.join(", ");
                const metadata = [
                  status,
                  modelDetails?.name && modelDetails.name !== model ? modelDetails.name : undefined,
                  family,
                  modelDetails?.parameterSize,
                  modelDetails?.contextLength ? `${modelDetails.contextLength.toLocaleString()} context` : undefined,
                  modelDetails?.free === true ? "free per catalog" : undefined,
                  formatModelSize(modelDetails?.sizeBytes),
                ]
                  .filter(Boolean)
                  .join(" · ");
                return <option key={`${selectedProviderInfo?.id || "provider"}:${model}`} value={model}>{model} · {metadata}</option>;
              })}
            </select>
            {modelDiscoveryError && <small role="alert">{modelDiscoveryError}</small>}
            {!modelsBusy && !models.length && (
              <small role="status">
                {diagnostics?.server.status === "connected"
                  ? selectedProvider === "ollama"
                    ? "Ollama is reachable but has no installed models. Run `ollama pull <model>` and refresh."
                    : selectedProvider === "lm-studio"
                      ? "LM Studio is reachable but returned no models. Load a model in LM Studio, then refresh."
                      : "The provider is reachable but returned no models."
                  : selectedProviderInfo?.configured
                    ? selectedProvider === "lm-studio"
                      ? "LM Studio is not reachable. Open Developer → Local Server, start it on port 1234, then retry."
                      : selectedProvider === "ollama"
                        ? "Ollama is not reachable. Start Ollama and verify OLLAMA_URL, then retry."
                        : "The provider is not reachable. Check its service status and retry."
                    : `Not configured. Set ${selectedProviderInfo?.credentialEnv || "the API key"} in the backend .env file, restart Maya, and retry.`}
              </small>
            )}
          </label>
          <div className="field field-wide auth-requirement">
            <span><span>Backend API authentication</span><b className={`state-label ${authRequired ? "state-warning" : "state-good"}`}>{authRequired ? "Token required" : "Not required"}</b></span>
            <small>{authRequired
              ? "This Maya server requires its API_AUTH_TOKEN. Enter the matching token below; it is kept in this tab only."
              : "No backend API token is configured or required. Local Ollama and LM Studio also need no cloud provider key."}</small>
          </div>
          {authRequired && <>
            <label className="field field-wide">
              <span>Backend API token <small>Separate from cloud provider API keys.</small></span>
              <input type="password" autoComplete="off" value={apiToken} onChange={(event) => onTokenChange(event.target.value)} placeholder="Enter the token configured on the Maya server" />
            </label>
            <div className="field-wide token-save-row">
              <button type="button" className="secondary-button" onClick={onSaveToken}>Save token for this tab</button>
            </div>
          </>}
        </div>
        <section className="cloud-provider-list" aria-labelledby="cloud-provider-heading">
          <div className="cloud-provider-heading"><h4 id="cloud-provider-heading">Cloud credentials</h4><small>Optional · stored only in the backend environment</small></div>
          {providers.filter((provider) => !provider.local).map((provider) => (
            <div className="cloud-provider-row" key={provider.id}>
              <span><strong>{provider.name}</strong><small>{provider.credentialEnv || "Provider API key"}</small></span>
              <span className={`state-label ${provider.credentialStatus === "invalid" ? "state-warning" : !provider.configured ? "state-warning" : provider.enabled === false ? "state-muted" : "state-neutral"}`}>
                {provider.credentialStatus === "invalid" ? "Invalid key format" : !provider.configured ? "Not configured" : provider.enabled === false ? "Disabled" : "Configured · test required"}
              </span>
            </div>
          ))}
          <p>To configure a cloud provider, set its named variable in the backend <code>.env</code> and restart Maya. Never paste cloud keys into this page.</p>
        </section>
        </div>}

        {activeSection === "preferences" && <div className="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby="settings-tab-preferences">
          <div className="settings-section-heading"><div><h3>General preferences</h3><p>Adjust Maya’s appearance and response behavior.</p></div></div>
          <div className="settings-grid">
            <label className="field">
              <span>Appearance</span>
              <select value={state.theme} onChange={(event) => onChangeSetting("theme", event.target.value as "dark" | "light")}>
                <option value="dark">Dark</option><option value="light">Light</option>
              </select>
            </label>
            <label className="field">
              <span>Font size</span>
              <select value={String(settings.fontSize || "medium")} onChange={(event) => onChangeSetting("fontSize", event.target.value)}>
                <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
              </select>
            </label>
            <label className="field field-wide">
              <span>Personal memory</span>
              <span className="setting-note">
                <input type="checkbox" checked={Boolean(settings.useMemory) && Boolean(selectedProviderInfo?.local)} disabled={!selectedProviderInfo?.local} onChange={(event) => onChangeSetting("useMemory", event.target.checked)} />
                Use only memories I explicitly save in local chats
              </span>
              <small>Memories are never sent to cloud providers and do not change model weights.</small>
            </label>
            <label className="field field-wide">
              <span>Temperature <b>{Number(settings.temperature).toFixed(1)}</b></span>
              <input type="range" min="0" max="1" step="0.1" value={Number(settings.temperature)} onChange={(event) => onChangeSetting("temperature", Number(event.target.value))} />
              <small>Lower values make responses more focused; higher values increase variation.</small>
            </label>
            <label className="field">
              <span>Context size</span>
              <input type="number" min="512" max="4096" step="512" value={Number(settings.context)} onChange={(event) => onChangeSetting("context", Number(event.target.value))} />
            </label>
            <label className="field">
              <span>Maximum output tokens</span>
              <input type="number" min="128" max="4096" step="128" value={Number(settings.maxTokens)} onChange={(event) => onChangeSetting("maxTokens", Number(event.target.value))} />
              <small>Use 2048 or more for code generation.</small>
            </label>
            <label className="field field-wide">
              <span>Additional instructions</span>
              <textarea rows={4} maxLength={4000} value={String(settings.systemPrompt || "")} onChange={(event) => onChangeSetting("systemPrompt", event.target.value)} placeholder="Optional preferences for Maya's responses" />
            </label>
          </div>
        </div>}

        {activeSection === "data" && <div className="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby="settings-tab-data">
        <div className="settings-section-heading"><div><h3>Local data</h3><p>Your conversations and approved memories remain under your control.</p></div></div>
        <section className="memory-manager" aria-labelledby="memory-title">
          <div className="data-actions">
            <div><h3 id="memory-title">Approved memories</h3><p>Only items you add here are stored. Do not save secrets or private document excerpts.</p></div>
            <button type="button" className="secondary-button" disabled={memoryBusy} onClick={onRefreshMemories}>
              {memoryBusy ? "Loading…" : "Refresh"}
            </button>
          </div>
          <form onSubmit={async (event) => {
            event.preventDefault();
            if (await onSaveMemory({ title: memoryTitle, content: memoryContent }, editingMemoryId || undefined)) {
              setMemoryTitle("");
              setMemoryContent("");
              setEditingMemoryId(null);
            }
          }}>
            <label className="field">
              <span>{editingMemoryId ? "Edit memory" : "Add a memory"}</span>
              <input value={memoryTitle} onChange={(event) => setMemoryTitle(event.target.value)} maxLength={120} required placeholder="Title (e.g. Preferred language)" />
              <textarea value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} maxLength={2000} required rows={3} placeholder="A short fact or preference that Maya may use when you opt in to local memory." />
            </label>
            <div className="data-buttons">
              <button type="submit" className="primary-button" disabled={memoryBusy}>
                <Plus size={14} />{editingMemoryId ? "Save changes" : "Approve and save"}
              </button>
              {editingMemoryId && <button type="button" className="secondary-button" onClick={() => {
                setEditingMemoryId(null);
                setMemoryTitle("");
                setMemoryContent("");
              }}>Cancel</button>}
            </div>
          </form>
          {memoryError && <p role="alert" className="message-warning">{memoryError}</p>}
          <ul className="memory-list">
            {memories.map((memory) => (
              <li key={memory.id}>
                <div><strong>{memory.title}</strong><p>{memory.content}</p></div>
                <div className="data-buttons">
                  <button type="button" className="icon-button" aria-label={`Edit ${memory.title}`} onClick={() => {
                    setEditingMemoryId(memory.id);
                    setMemoryTitle(memory.title);
                    setMemoryContent(memory.content);
                  }}><Pencil size={14} /></button>
                  <button type="button" className="icon-button" aria-label={`Delete ${memory.title}`} onClick={() => onDeleteMemory(memory.id)}><Trash2 size={14} /></button>
                </div>
              </li>
            ))}
            {!memories.length && !memoryBusy && <li>No approved memories saved.</li>}
          </ul>
        </section>

        <div className="data-actions">
          <div><h3>Chat history</h3><p>Your conversations remain in this browser.</p></div>
          <div className="data-buttons">
            <button type="button" className="secondary-button" onClick={onExportChats}>Export</button>
            <label className="secondary-button import-label">Import<input type="file" accept="application/json,.json" onChange={(event) => {
              onImportChats(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }} /></label>
            <button type="button" className="danger-button" onClick={onClearChats}>Clear all</button>
          </div>
        </div>
        </div>}
        <div className="dialog-footer"><button type="button" className="primary-button" onClick={onClose}>Save Settings</button></div>
      </section>
    </div>
  );
}
