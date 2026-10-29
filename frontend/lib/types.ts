export type MessageRole = "user" | "assistant";

export type SourceReference = {
  kind: "document" | "web";
  documentId?: string;
  fileName?: string;
  chunkIndex?: number;
  title?: string;
  url?: string;
  date?: string;
};

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  timestamp?: string;
  sources?: SourceReference[];
  metrics?: GenerationMetrics;
  generating?: boolean;
};

export type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type MayaSettings = {
  provider: string;
  model: string;
  temperature: number;
  context: number;
  maxTokens: number;
  systemPrompt: string;
  webSearch: boolean;
  fontSize: string;
  [key: string]: unknown;
};

export type ProviderInfo = {
  id: string;
  name: string;
  local: boolean;
  configured: boolean;
  enabled?: boolean;
  defaultModel: string;
  baseUrl?: string;
  credentialEnv?: string;
  credentialStatus?: "missing" | "invalid" | "configured";
};

export type ProviderDiagnostics = {
  provider: { id: string; name: string; local: boolean };
  configured: boolean;
  endpoint: string;
  models: string[];
  modelDetails?: Array<{
    id: string;
    name?: string;
    family?: string;
    families?: string[];
    parameterSize?: string;
    sizeBytes?: number;
    contextLength?: number;
    free?: boolean;
  }>;
  modelStates: Array<{
    id: string;
    installed: boolean | null;
    available: boolean;
    verified: boolean;
    selected: boolean;
  }>;
  verifiedModels: string[];
  defaultModel: string;
  server: { status: "not_tested" | "connected" | "disconnected" | "error" };
  authentication: { status: "not_required" | "not_configured" | "not_tested" | "verified" | "failed" };
  model: { name: string; status: "not_tested" | "not_selected" | "available" | "verified" | "unavailable" };
  inference: { status: "not_requested" | "not_tested" | "passed" | "failed" };
  error?: { code: string; message: string };
};

export type SettingsSection = "providers" | "preferences" | "data";

export type MemoryEntry = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  approvedByUser: true;
};

export type FeedbackRating = "positive" | "negative";

export type FeedbackEntry = {
  messageId: string;
  conversationId: string;
  rating: FeedbackRating;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type GenerationMetrics = {
  provider: string;
  model: string;
  firstTokenMs: number | null;
  totalMs: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}

export type MayaState = {
  conversations: Conversation[];
  activeConversationId: string | null;
  theme: "dark" | "light";
  settings: MayaSettings;
  [key: string]: unknown;
};

export type DocumentItem = {
  id: string;
  fileName: string;
  chunkCount?: number;
  createdAt?: string;
};

export type WorkspaceInfo = {
  enabled: boolean;
  name?: string;
  id?: string;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size?: number;
};

export type WorkspaceProposal = {
  id: string;
  path: string;
  before: string | null;
  after: string;
  expiresAt: number;
};

export type WorkspaceSearchMatch = {
  path: string;
  line: number;
  text: string;
};

export type WorkspaceCheckResult = {
  check: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  outputTruncated: boolean;
};
