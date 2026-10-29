import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { createApp } from './app.js';
import { createOllamaClient } from './ollama.js';
import { createLmStudioClient } from './lm-studio.js';
import { createCloudProviders } from './cloud-providers.js';
import { createRagService } from './rag.js';
import { createSearchProvider } from './search.js';
import { createWorkspaceService } from './workspace.js';
import { createLearningStore } from './learning.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv({ path: path.join(projectRoot, '.env') });

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const configuredLocalProvider = (process.env.MAYA_LOCAL_PROVIDER || 'ollama').trim().toLowerCase();
if (!['ollama', 'lm-studio'].includes(configuredLocalProvider)) {
  throw new Error('MAYA_LOCAL_PROVIDER must be "ollama" or "lm-studio".');
}
const configuredEmbeddingProvider = (process.env.MAYA_EMBEDDING_PROVIDER || 'ollama').trim().toLowerCase();
if (!['ollama', 'lm-studio'].includes(configuredEmbeddingProvider)) {
  throw new Error('MAYA_EMBEDDING_PROVIDER must be "ollama" or "lm-studio".');
}
const ollama = createOllamaClient();
const lmStudio = createLmStudioClient();
const localAdapters = { ollama, 'lm-studio': lmStudio };
const localModel = localAdapters[configuredLocalProvider];
const localProviderName = configuredLocalProvider === 'lm-studio' ? 'LM Studio' : 'Ollama';
const embeddingClient = localAdapters[configuredEmbeddingProvider];
const embeddingProviderName = configuredEmbeddingProvider === 'lm-studio' ? 'LM Studio' : 'Ollama';
const defaultModel = configuredLocalProvider === 'lm-studio' ? lmStudio.defaultModel : ollama.defaultModel;
const cloudProviders = createCloudProviders();
const providers = {
  ollama: { ...ollama, id: 'ollama', name: 'Ollama', local: true, configured: true },
  'lm-studio': { ...lmStudio, id: 'lm-studio', name: 'LM Studio', local: true, configured: true },
  ...cloudProviders,
};
const rag = createRagService({ embedTexts: embeddingClient.embedTexts });
const learningService = createLearningStore();
const searchProvider = createSearchProvider();
const workspaceService = createWorkspaceService({ rootPath: process.env.MAYA_WORKSPACE_ROOT || '' });
const app = createApp({
  ollama: localModel,
  providers,
  defaultProvider: configuredLocalProvider,
  rag,
  learningService,
  searchProvider,
  workspaceService,
  localProviderName,
  embeddingProviderName,
  defaultModel,
  corsOrigins: process.env.CORS_ORIGINS,
});

export { app };

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(port, host, () => {
    console.log(`Maya is running at http://${host}:${port}`);
    console.log(`Local runtime: ${localProviderName}`);
    console.log(defaultModel ? `Configured local model: ${defaultModel}` : 'Local chat models will be discovered from the provider.');
    for (const provider of Object.values(cloudProviders)) {
      const credentialStatus = provider.credentialStatus === 'invalid'
        ? 'invalid key format'
        : provider.configured ? 'configured' : 'not configured';
      console.log(`${provider.name}: ${credentialStatus}`);
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Cannot start Maya: ${host}:${port} is already in use. Stop the existing server or set PORT to an available port.`);
      process.exitCode = 1;
      return;
    }

    console.error(`Cannot start Maya on ${host}:${port}: ${error.message}`);
    process.exitCode = 1;
  });
}
