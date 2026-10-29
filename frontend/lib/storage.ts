import type { ChatMessage, Conversation, MayaSettings, MayaState } from "./types";

export const STORAGE_KEY = "maya-state";

export const DEFAULT_SETTINGS: MayaSettings = {
  provider: "local",
  model: "",
  useMemory: false,
  temperature: 0.7,
  context: 2048,
  maxTokens: 2048,
  systemPrompt: "",
  webSearch: false,
  fontSize: "medium",
};

export const EMPTY_STATE: MayaState = {
  conversations: [],
  activeConversationId: null,
  theme: "dark",
  settings: DEFAULT_SETTINGS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessage(value: unknown, index: number): ChatMessage | null {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) return null;
  if (typeof value.content !== "string") return null;

  return {
    ...value,
    id: typeof value.id === "string" ? value.id : `legacy-message-${index}-${crypto.randomUUID()}`,
    role: value.role,
    content: value.content,
    generating: false,
  } as ChatMessage;
}

function normalizeConversation(value: unknown): Conversation | null {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.messages)) return null;
  const normalizedMessages = value.messages.map((message, index) => normalizeMessage(message, index));
  if (normalizedMessages.some((message) => message === null)) {
    throw new Error("Saved Maya history contains an invalid message; it was kept unchanged.");
  }
  const messages = normalizedMessages.filter((message): message is ChatMessage => message !== null);
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();

  return {
    ...value,
    id: value.id,
    title: typeof value.title === "string" ? value.title : "Untitled chat",
    messages,
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  } as Conversation;
}

export function normalizeState(value: unknown): MayaState {
  if (!isRecord(value)) throw new Error("Saved Maya history is not a valid state object.");
  if (value.conversations !== undefined && !Array.isArray(value.conversations)) {
    throw new Error("Saved Maya history has an invalid conversations list.");
  }

  const normalizedConversations = (Array.isArray(value.conversations) ? value.conversations : [])
    .map(normalizeConversation);
  if (normalizedConversations.some((conversation) => conversation === null)) {
    throw new Error("Saved Maya history contains an invalid conversation; it was kept unchanged.");
  }
  const conversations = normalizedConversations.filter((conversation): conversation is Conversation => conversation !== null);
  const settings = isRecord(value.settings) ? value.settings : {};
  const requestedActiveId = typeof value.activeConversationId === "string" ? value.activeConversationId : null;

  return {
    ...value,
    conversations,
    activeConversationId: conversations.some((conversation) => conversation.id === requestedActiveId)
      ? requestedActiveId
      : conversations[0]?.id ?? null,
    theme: value.theme === "light" ? "light" : "dark",
    settings: {
      ...DEFAULT_SETTINGS,
      ...settings,
      provider: ["local", "ollama", "lm-studio", "deepseek", "openai", "gemini", "anthropic"].includes(String(settings.provider))
        ? String(settings.provider)
        : "local",
    },
  } as MayaState;
}

export function createConversation(): Conversation {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}
