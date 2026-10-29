import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeState } from "../lib/storage";

test("normalizeState preserves the existing maya-state conversation and settings shape", () => {
  const oldState = {
    activeConversationId: "chat-1",
    theme: "light",
    settings: { model: "qwen3:4b", temperature: 0.4, webSearch: true, fontSize: "large" },
    conversations: [{
      id: "chat-1",
      title: "Existing saved conversation",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:05:00.000Z",
      messages: [
        { id: "user-1", role: "user", content: "Remember this message", timestamp: "2025-01-01T00:00:00.000Z" },
        { id: "assistant-1", role: "assistant", content: "I will.", timestamp: "2025-01-01T00:01:00.000Z", sources: [{ kind: "document", fileName: "notes.md", chunkIndex: 1 }] },
      ],
    }],
  };

  const result = normalizeState(oldState);

  assert.equal(result.activeConversationId, "chat-1");
  assert.equal(result.theme, "light");
  assert.equal(result.settings.model, "qwen3:4b");
  assert.equal(result.settings.temperature, 0.4);
  assert.equal(result.settings.webSearch, true);
  assert.equal(result.settings.fontSize, "large");
  assert.equal(result.conversations[0].messages[0].content, "Remember this message");
  assert.deepEqual(result.conversations[0].messages[1].sources, [{ kind: "document", fileName: "notes.md", chunkIndex: 1 }]);
});

test("normalizeState upgrades legacy messages without IDs and preserves content", () => {
  const result = normalizeState({
    conversations: [{
      id: "legacy-chat",
      messages: [{ role: "assistant", content: "Saved before IDs existed", generating: true }],
    }],
  });

  assert.equal(result.conversations[0].messages[0].content, "Saved before IDs existed");
  assert.equal(result.conversations[0].messages[0].generating, false);
  assert.ok(result.conversations[0].messages[0].id);
});

test("normalizeState refuses malformed history rather than replacing it with an empty state", () => {
  assert.throws(() => normalizeState({ conversations: "not-an-array" }), /invalid conversations list/);
  assert.throws(() => normalizeState({ conversations: [{ id: "partial", messages: ["not a message"] }] }), /invalid message/);
  assert.throws(() => normalizeState({ conversations: [null] }), /invalid conversation/);
});

test("normalizeState migrates a saved cloud provider setting without losing conversations", () => {
  const result = normalizeState({
    settings: { provider: "cloud", model: "qwen3:4b" },
    conversations: [{ id: "saved-chat", messages: [{ role: "user", content: "Keep my history" }] }],
  });

  assert.equal(result.settings.provider, "local");
  assert.equal(result.conversations[0].messages[0].content, "Keep my history");
});

test("normalizeState preserves recognized explicit provider and model preferences", () => {
  const result = normalizeState({
    settings: { provider: "deepseek", model: "deepseek-flash" },
    conversations: [{ id: "saved-chat", messages: [{ role: "user", content: "Keep my history" }] }],
  });
  assert.equal(result.settings.provider, "deepseek");
  assert.equal(result.settings.model, "deepseek-flash");
  assert.equal(result.conversations[0].messages[0].content, "Keep my history");
});
