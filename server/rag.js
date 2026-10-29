import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import { ChromaClient } from 'chromadb';

const COLLECTION_NAME = 'maya_documents';
const MAX_EXTRACTED_CHARACTERS = 1_000_000;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 160;
const EMBEDDING_BATCH_SIZE = 24;
const CHROMA_URL = parseChromaUrl(process.env.CHROMA_URL || 'http://127.0.0.1:8000');
const EMBEDDING_PROVIDER = (process.env.MAYA_EMBEDDING_PROVIDER || 'ollama').trim().toLowerCase();
const EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL
  || (EMBEDDING_PROVIDER === 'lm-studio'
    ? process.env.LM_STUDIO_EMBEDDING_MODEL || ''
    : process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text');
const MAX_DISTANCE = Number(process.env.RAG_MAX_DISTANCE) || 0.45;

export class DocumentProcessingError extends Error {}

export class ChromaStorageError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ChromaStorageError';
    this.code = code;
    this.status = status;
  }
}

const chromaClient = new ChromaClient({
  host: CHROMA_URL.hostname,
  port: Number(CHROMA_URL.port || (CHROMA_URL.protocol === 'https:' ? 443 : 8000)),
  ssl: CHROMA_URL.protocol === 'https:',
});

export function parseChromaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CHROMA_URL must be a valid local Chroma URL, for example http://127.0.0.1:8000');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || !isLocalChromaHost(hostname)) {
    throw new Error('CHROMA_URL must point to a local Chroma server without credentials, URL paths, or query parameters');
  }
  return url;
}

function isLocalChromaHost(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === 'chroma' || hostname === 'host.docker.internal'
    || hostname.endsWith('.local')) return true;
  const version = isIP(hostname);
  if (version === 4) {
    const [first, second] = hostname.split('.').map(Number);
    return first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (version === 6) return hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:');
  return false;
}

function describeChromaError(error, operation = 'initialize') {
  const errorName = String(error?.name || '');
  const message = String(error?.message || '');
  if (errorName === 'ChromaConnectionError'
    || /ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|failed to connect/i.test(message)) {
    return new ChromaStorageError(
      'CHROMA_UNAVAILABLE',
      `ChromaDB is not reachable at ${CHROMA_URL.origin}. Start Docker Desktop, then run "docker compose up -d chroma" from the project directory.`,
      'unavailable',
    );
  }
  if (errorName === 'ChromaNotFoundError' || /\b404\b/.test(message)) {
    return new ChromaStorageError(
      'CHROMA_URL_INCORRECT',
      `The service at ${CHROMA_URL.origin} did not respond as the expected Chroma API. Verify CHROMA_URL and that it points to the Chroma service.`,
      'misconfigured',
    );
  }
  return new ChromaStorageError(
    'CHROMA_INITIALIZATION_FAILED',
    `ChromaDB at ${CHROMA_URL.origin} responded, but Maya could not ${operation}. Check the Chroma container logs, API compatibility, and its tenant/database configuration.`,
    'initialization_error',
  );
}

export function createRagService({ embedTexts, client = chromaClient } = {}) {
  let collectionPromise;
  const getCollection = async () => {
    if (!collectionPromise) {
      collectionPromise = client.getOrCreateCollection({
        name: COLLECTION_NAME,
        metadata: { 'hnsw:space': 'cosine' },
        embeddingFunction: null,
      });
    }
    try {
      return await collectionPromise;
    } catch (error) {
      collectionPromise = null;
      throw describeChromaError(error, 'initialize the maya_documents collection');
    }
  };

  async function extractText(file) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension === '.pdf') {
      if (file.buffer.length < 5 || file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new DocumentProcessingError('The uploaded file is not a valid PDF');
      }
      const parser = new PDFParse({ data: file.buffer });
      try {
        const result = await parser.getText();
        return result.text.slice(0, MAX_EXTRACTED_CHARACTERS).trim();
      } catch {
        throw new DocumentProcessingError('Unable to extract text from this PDF');
      } finally {
        await parser.destroy();
      }
    }
    if (file.buffer.includes(0)) throw new DocumentProcessingError('Text documents must not contain binary data');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(file.buffer).slice(0, MAX_EXTRACTED_CHARACTERS).trim();
    } catch {
      throw new DocumentProcessingError('Text documents must use UTF-8 encoding');
    }
  }

  return {
    async checkStorage() {
      try {
        await client.heartbeat();
      } catch (error) {
        const diagnostic = describeChromaError(error, 'check ChromaDB connectivity');
        return { ok: false, status: diagnostic.status, code: diagnostic.code, error: diagnostic.message, url: CHROMA_URL.origin };
      }
      try {
        const collectionCount = await client.countCollections();
        return { ok: true, status: 'ready', url: CHROMA_URL.origin, collectionCount };
      } catch (error) {
        const diagnostic = describeChromaError(error, 'initialize the Chroma database');
        return { ok: false, status: diagnostic.status, code: diagnostic.code, error: diagnostic.message, url: CHROMA_URL.origin };
      }
    },

    async listDocuments() {
      const collection = await getCollection();
      let result;
      try {
        result = await collection.get({ include: ['metadatas'], limit: 10000 });
      } catch (error) {
        throw describeChromaError(error, 'list documents');
      }
      const documents = new Map();
      for (const metadata of result.metadatas || []) {
        if (!metadata?.documentId || typeof metadata.fileName !== 'string') continue;
        const document = documents.get(metadata.documentId) || {
          id: metadata.documentId,
          name: metadata.fileName,
          createdAt: metadata.createdAt || '',
          chunks: 0,
        };
        document.chunks += 1;
        documents.set(document.id, document);
      }
      return [...documents.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    async ingestDocument(file) {
      const name = path.basename(file.originalname.replace(/\\/g, '/'))
        .replace(/[^\p{L}\p{N}._ -]/gu, '_')
        .slice(0, 180);
      const text = await extractText(file);
      if (!text) throw new DocumentProcessingError('The document contains no extractable text');

      const chunks = chunkText(text);
      const documentId = randomUUID();
      const createdAt = new Date().toISOString();
      const recordIds = chunks.map(() => randomUUID());
      const collection = await getCollection();
      const insertedIds = [];
      try {
        for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
          const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
          const ids = recordIds.slice(offset, offset + EMBEDDING_BATCH_SIZE);
          const embeddings = await embedTexts(batch, EMBEDDING_MODEL);
          if (!Array.isArray(embeddings) || embeddings.length !== batch.length || embeddings.some((item) => !Array.isArray(item) || !item.length)) {
            throw new Error('The local embedding provider returned invalid document embeddings');
          }
          await collection.add({
            ids,
            embeddings,
            documents: batch,
            metadatas: batch.map((_, index) => ({
              documentId,
              fileName: name,
              chunkIndex: offset + index + 1,
              createdAt,
              embeddingModel: EMBEDDING_MODEL,
            })),
          });
          insertedIds.push(...ids);
        }
      } catch (error) {
        if (insertedIds.length) {
          try {
            await collection.delete({ ids: insertedIds });
          } catch (cleanupError) {
            throw describeChromaError(cleanupError, 'roll back a partial document upload');
          }
        }
        if (error?.name?.startsWith('Chroma')) throw describeChromaError(error, 'store document embeddings');
        throw error;
      }

      return { id: documentId, name, createdAt, chunks: chunks.length };
    },

    async deleteDocument(documentId) {
      const collection = await getCollection();
      try {
        const result = await collection.get({
          where: { documentId },
          include: ['metadatas'],
          limit: 10000,
        });
        if (!result.ids.length) return false;
        await collection.delete({ ids: result.ids });
        return true;
      } catch (error) {
        throw describeChromaError(error, 'delete a document');
      }
    },

    async retrieve(query) {
      const collection = await getCollection();
      let count;
      try {
        count = await collection.count();
      } catch (error) {
        throw describeChromaError(error, 'retrieve document passages');
      }
      if (count === 0) return [];
      const [embedding] = await embedTexts([query], EMBEDDING_MODEL);
      if (!Array.isArray(embedding) || !embedding.length) throw new Error('The local embedding provider returned an invalid query embedding');
      let result;
      try {
        result = await collection.query({
          queryEmbeddings: [embedding],
          nResults: 5,
          where: { embeddingModel: EMBEDDING_MODEL },
          include: ['documents', 'metadatas', 'distances'],
        });
      } catch (error) {
        throw describeChromaError(error, 'retrieve document passages');
      }
      const documents = result.documents?.[0] || [];
      const metadatas = result.metadatas?.[0] || [];
      const distances = result.distances?.[0] || [];
      return documents.flatMap((content, index) => {
        const metadata = metadatas[index];
        const distance = distances[index];
        if (typeof content !== 'string' || !metadata?.documentId || (Number.isFinite(distance) && distance > MAX_DISTANCE)) return [];
        return [{
          documentId: metadata.documentId,
          fileName: metadata.fileName,
          chunkIndex: metadata.chunkIndex,
          content,
          distance,
        }];
      });
    },
  };
}

function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + CHUNK_SIZE / 2) end = boundary;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}
