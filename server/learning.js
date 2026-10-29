import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_MEMORIES = 500;
const MAX_FEEDBACK = 5000;
const MAX_MEMORY_TITLE = 120;
const MAX_MEMORY_CONTENT = 2000;
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
];

export class LearningStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'LearningStoreError';
    this.code = code;
  }
}

function dataDirectory() {
  if (process.env.MAYA_DATA_DIR) return path.resolve(process.env.MAYA_DATA_DIR);
  const root = process.env.LOCALAPPDATA
    || process.env.XDG_DATA_HOME
    || path.join(os.homedir(), '.local', 'share');
  return path.join(root, 'Maya AI');
}

function emptyStore() {
  return { version: 1, memories: [], feedback: [] };
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateStore(data) {
  if (!data || typeof data !== 'object' || data.version !== 1
    || !Array.isArray(data.memories) || !Array.isArray(data.feedback)
    || data.memories.length > MAX_MEMORIES || data.feedback.length > MAX_FEEDBACK) {
    throw new LearningStoreError('LEARNING_STORE_CORRUPT', 'Maya learning data has an unsupported or invalid format; the existing file was left unchanged.');
  }
  const memoriesAreValid = data.memories.every((memory) => memory && typeof memory === 'object'
    && Object.keys(memory).sort().join(',') === 'approvedByUser,content,createdAt,id,title,updatedAt'
    && memory.approvedByUser === true
    && isUuid(memory.id)
    && typeof memory.title === 'string' && memory.title.length > 0 && memory.title.length <= MAX_MEMORY_TITLE
    && typeof memory.content === 'string' && memory.content.length > 0 && memory.content.length <= MAX_MEMORY_CONTENT
    && isTimestamp(memory.createdAt) && isTimestamp(memory.updatedAt));
  const feedbackIsValid = data.feedback.every((entry) => entry && typeof entry === 'object'
    && Object.keys(entry).sort().join(',') === 'conversationId,createdAt,messageId,model,provider,rating,updatedAt'
    && isUuid(entry.messageId) && isUuid(entry.conversationId)
    && ['positive', 'negative'].includes(entry.rating)
    && typeof entry.provider === 'string' && entry.provider.length > 0 && entry.provider.length <= 32
    && typeof entry.model === 'string' && entry.model.length > 0 && entry.model.length <= 120
    && isTimestamp(entry.createdAt) && isTimestamp(entry.updatedAt));
  if (!memoriesAreValid || !feedbackIsValid) {
    throw new LearningStoreError('LEARNING_STORE_CORRUPT', 'Maya learning data contains an invalid record; the existing file was left unchanged.');
  }
  return data;
}

function safeText(value, field, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new LearningStoreError('INVALID_LEARNING_INPUT', `${field} must be ${allowEmpty ? 'at most' : 'non-empty and at most'} ${maximum} characters.`);
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new LearningStoreError('SENSITIVE_CONTENT_REJECTED', `${field} appears to contain a credential. Remove secrets before saving.`);
  }
  return value.trim();
}

function validId(value, field) {
  if (!isUuid(value)) {
    throw new LearningStoreError('INVALID_LEARNING_INPUT', `${field} must be a valid ID.`);
  }
  return value;
}

function rankedMemories(memories, query, limit) {
  const terms = new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 40));
  if (!terms.size) return [];
  return memories.map((memory) => {
    const text = `${memory.title} ${memory.content}`.toLocaleLowerCase();
    const score = [...terms].reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
    return { memory, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
    .slice(0, limit)
    .map(({ memory }) => ({ ...memory }));
}

export function createLearningStore({ filePath = path.join(dataDirectory(), 'learning.json') } = {}) {
  let writeQueue = Promise.resolve();

  async function read() {
    try {
      return validateStore(JSON.parse(await fs.readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyStore();
      if (error instanceof LearningStoreError) throw error;
      if (error instanceof SyntaxError) {
        throw new LearningStoreError('LEARNING_STORE_CORRUPT', 'Maya learning data is not valid JSON; the existing file was left unchanged.', { cause: error });
      }
      throw new LearningStoreError('LEARNING_STORE_UNAVAILABLE', 'Maya could not read local learning data. Check the configured data directory and permissions.', { cause: error });
    }
  }

  async function persist(data) {
    const directory = path.dirname(filePath);
    let temporaryPath;
    try {
      await fs.mkdir(directory, { recursive: true });
      temporaryPath = path.join(directory, `.learning-${randomUUID()}.tmp`);
      const handle = await fs.open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      throw new LearningStoreError('LEARNING_STORE_UNAVAILABLE', 'Maya could not persist local learning data. Check the configured data directory and permissions.', { cause: error });
    } finally {
      if (temporaryPath) {
        try {
          await fs.rm(temporaryPath, { force: true });
        } catch (error) {
          throw new LearningStoreError('LEARNING_STORE_UNAVAILABLE', 'Maya could not clean up a temporary learning-data file.', { cause: error });
        }
      }
    }
  }

  function mutate(operation) {
    const task = writeQueue.then(async () => {
      const data = await read();
      const result = operation(data);
      await persist(data);
      return result;
    });
    writeQueue = task.catch(() => undefined);
    return task;
  }

  return {
    async listMemories(query = '') {
      await writeQueue;
      const { memories } = await read();
      if (query) return rankedMemories(memories, query, MAX_MEMORIES);
      return memories.map((memory) => ({ ...memory })).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async retrieveMemories(query) {
      await writeQueue;
      const { memories } = await read();
      return rankedMemories(memories, query, 5);
    },

    async createMemory({ title, content }) {
      const now = new Date().toISOString();
      const memory = {
        id: randomUUID(),
        title: safeText(title, 'Memory title', MAX_MEMORY_TITLE),
        content: safeText(content, 'Memory content', MAX_MEMORY_CONTENT),
        createdAt: now,
        updatedAt: now,
        approvedByUser: true,
      };
      return mutate((data) => {
        if (data.memories.length >= MAX_MEMORIES) {
          throw new LearningStoreError('LEARNING_STORE_LIMIT', `Maya stores at most ${MAX_MEMORIES} explicit memories. Delete an unused memory before adding another.`);
        }
        data.memories.push(memory);
        return { ...memory };
      });
    },

    async updateMemory(id, { title, content }) {
      validId(id, 'Memory ID');
      const nextTitle = safeText(title, 'Memory title', MAX_MEMORY_TITLE);
      const nextContent = safeText(content, 'Memory content', MAX_MEMORY_CONTENT);
      return mutate((data) => {
        const memory = data.memories.find((item) => item.id === id);
        if (!memory) return null;
        memory.title = nextTitle;
        memory.content = nextContent;
        memory.updatedAt = new Date().toISOString();
        return { ...memory };
      });
    },

    async deleteMemory(id) {
      validId(id, 'Memory ID');
      return mutate((data) => {
        const index = data.memories.findIndex((item) => item.id === id);
        if (index < 0) return false;
        data.memories.splice(index, 1);
        return true;
      });
    },

    async listFeedback() {
      await writeQueue;
      const { feedback } = await read();
      return feedback.map((item) => ({ ...item })).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async recordFeedback({ messageId, conversationId, rating, provider, model }) {
      validId(messageId, 'Message ID');
      validId(conversationId, 'Conversation ID');
      if (!['positive', 'negative'].includes(rating)) {
        throw new LearningStoreError('INVALID_LEARNING_INPUT', 'Feedback rating must be positive or negative.');
      }
      const safeProvider = safeText(provider, 'Provider', 32);
      const safeModel = safeText(model, 'Model', 120);
      const now = new Date().toISOString();
      return mutate((data) => {
        const existing = data.feedback.find((item) => item.messageId === messageId);
        if (existing) {
          Object.assign(existing, { conversationId, rating, provider: safeProvider, model: safeModel, updatedAt: now });
          return { ...existing };
        }
        if (data.feedback.length >= MAX_FEEDBACK) {
          throw new LearningStoreError('LEARNING_STORE_LIMIT', `Maya stores at most ${MAX_FEEDBACK} feedback entries.`);
        }
        const entry = {
          messageId,
          conversationId,
          rating,
          provider: safeProvider,
          model: safeModel,
          createdAt: now,
          updatedAt: now,
        };
        data.feedback.push(entry);
        return { ...entry };
      });
    },

    async deleteFeedback(messageId) {
      validId(messageId, 'Message ID');
      return mutate((data) => {
        const index = data.feedback.findIndex((item) => item.messageId === messageId);
        if (index < 0) return false;
        data.feedback.splice(index, 1);
        return true;
      });
    },
  };
}
