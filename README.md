# Maya AI — Local-First Assistant

Maya is a personal, local-first assistant built with a Next.js App Router frontend (React, TypeScript, and Tailwind CSS), Node.js, and Express. Ollama remains the default runtime; LM Studio can be selected explicitly through its local OpenAI-compatible API. Chat history stays in the browser. Chat generation, document embeddings, and vector retrieval use local services by default.

```text
Next.js UI -> same-origin Next.js API proxy -> Express -> Ollama or LM Studio (local chat)
                                                      -> explicitly selected DeepSeek/OpenAI/OpenRouter/Gemini/Anthropic (optional cloud chat)
                                                      -> configured local embedding runtime
                                                      -> ChromaDB (optional local document retrieval)
                                                      -> optional Brave Search (external, explicit opt-in)
```

No hosted AI API is required. Cloud providers are disabled until server-side keys are configured and a user explicitly selects one in Settings. Web search is disabled unless configured and explicitly enabled in the composer.

## Repository Layout

```text
.
├── frontend/                     Next.js App Router frontend
├── server/app.js                 Injectable Express application
├── server/server.js              Production entrypoint
├── server/ollama.js              Ollama chat and embedding adapter
├── server/lm-studio.js           Loopback-only LM Studio OpenAI-compatible adapter
├── server/cloud-providers.js     Optional DeepSeek/OpenAI/OpenRouter/Gemini/Anthropic adapters
├── server/rag.js                 Local document parsing and Chroma retrieval
├── server/search.js              Optional web-search provider
├── training/                     Curated SFT dataset validation and read-only preflight
├── tests/                        Backend and evaluation tests
├── Dockerfile                    Production container
├── docker-compose.yml             Maya + Ollama development stack
├── .devcontainer/                GitHub Codespaces configuration
└── .github/workflows/             CI and manual deployment workflows
```

## Requirements

- Node.js 22+ and npm
- Ollama 0.9+ (default provider) or LM Studio (explicit optional provider)
- Docker Compose for the bundled ChromaDB service (optional unless using RAG)
- 16 GB RAM recommended; a GPU is optional. Maya defaults to a 2048-token context and output budget. Context and output are capped at 4096 tokens; larger outputs need more time and memory, and a 4 GB GPU may still be unable to complete a long response.

## GitHub Repository Setup

```bash
git clone https://github.com/sushant-jpg/maya-Ai-chatboad.git
cd maya-Ai-chatboad
npm ci
npm --prefix frontend ci
```

On Windows PowerShell, copy the environment example with `Copy-Item .env.example .env`; on macOS/Linux use `cp .env.example .env`. Do not commit `.env`, `node_modules`, model files, or secrets.

## Next.js Frontend (Current UI)

The Next.js app in `frontend/` runs on port `3001` and proxies `/api/*` to the Express backend on port `3000` by default.

In PowerShell, copy the frontend-specific environment example:

```powershell
Copy-Item frontend\.env.example frontend\.env.local
```

In one terminal, start the API:

```powershell
npm run server
```

From the repository root, start the Next.js frontend:

```powershell
npm run dev
```

Open `http://localhost:3001`. To run the production frontend, use `npm --prefix frontend run build` followed by `npm --prefix frontend run start`. Frontend checks are `npm --prefix frontend run lint`, `npm --prefix frontend run typecheck`, and `npm --prefix frontend test`.

Frontend environment variables:

- `MAYA_API_ORIGIN`: private Express origin used by the Next.js server-side proxy; defaults to `http://127.0.0.1:3000`. Do not put credentials in this URL.
- `NEXT_PUBLIC_API_BASE_URL`: optional direct API base including `/api`, for example `https://YOUR-BACKEND.example.com/api`. When set, browser requests go directly to that endpoint; add the exact frontend origin to backend `CORS_ORIGINS`. Never put backend secrets, Ollama URLs, or Chroma URLs in `NEXT_PUBLIC_*` variables.

The bearer token, when the backend requires it, is entered in Settings and kept in the current browser tab's `sessionStorage`. The UI checks the non-secret `GET /api/auth/status` diagnostic first, so local users are not prompted for an application token when `API_AUTH_TOKEN` is unset. The token is not saved with chat history or shipped as a frontend build variable. Provider API keys are configured only in the backend `.env`; Maya intentionally never accepts or stores provider keys in browser storage.

## Provider Configuration and Diagnostics

The backend owns provider endpoints and credentials. Configure `.env` (copied from `.env.example`) and restart `npm run server` after changing provider variables. Maya does not silently fall back to another provider. The provider and model selected in Settings are saved with the browser's existing Maya settings and included explicitly with each chat request.

Local provider settings:

```env
MAYA_LOCAL_PROVIDER=lm-studio
LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
LM_STUDIO_MODEL=google/gemma-4-e4b
LM_STUDIO_API_KEY=
LM_STUDIO_TIMEOUT_MS=120000

OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=
OLLAMA_TIMEOUT_MS=120000
```

Set `MAYA_LOCAL_PROVIDER=ollama` to use Ollama as the backend's default provider, or `lm-studio` to use LM Studio. The other local provider remains selectable in Settings. LM Studio accepts loopback URLs only. Ollama URLs are restricted to loopback, private, or local Docker hosts. Maya requests installed/loaded model IDs from each running service; the configured chat model is not assumed to be installed. Keep `MAYA_EMBEDDING_PROVIDER` and the matching embedding model variables separate from chat model selection. Changing embedding configuration does not modify existing ChromaDB collections or re-embed documents.

To start LM Studio, open **Developer -> Local Server**, load the chat model, and start its server at `127.0.0.1:1234`. If local server authentication is enabled, set `LM_STUDIO_API_KEY` in the backend `.env`. Check that the actual server is listening before testing:

```powershell
Test-NetConnection 127.0.0.1 -Port 1234
Invoke-RestMethod http://127.0.0.1:1234/v1/models
Invoke-RestMethod http://127.0.0.1:3000/api/health?provider=lm-studio
```

For Ollama, start its local service and verify the installed models with `ollama list` or `Invoke-RestMethod http://127.0.0.1:11434/api/tags`. Maya's Settings can refresh the model catalog, test server/authentication/model status, and run a small inference test for the selected model.

Cloud provider credentials are server-side only. Add only the keys for providers you explicitly intend to use, then restart the backend:

```env
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
OPENROUTER_API_KEY=
GOOGLE_API_KEY=
ANTHROPIC_API_KEY=
MAYA_ENABLE_OPENAI=true
MAYA_ENABLE_DEEPSEEK=true
MAYA_ENABLE_OPENROUTER=true
MAYA_ENABLE_GEMINI=true
MAYA_ENABLE_ANTHROPIC=true
MAYA_PROVIDER_TIMEOUT_MS=120000
MAYA_PROVIDER_TEST_TIMEOUT_MS=60000
```

DeepSeek's documented API uses `https://api.deepseek.com/chat/completions` with Bearer authentication. Its current documentation lists `deepseek-flash` and `deepseek-v4-pro` as model IDs. Maya discovers the actual account/API model IDs from DeepSeek's authenticated `/models` endpoint rather than relying on a baked-in model list; model/account access and billing are controlled by DeepSeek.

Provider adapters use each service's own authentication and streaming API. OpenAI and DeepSeek use their documented OpenAI-compatible endpoints; OpenRouter uses its documented OpenAI-compatible API and dynamically lists models from its authenticated catalog; Gemini uses the Google Generative Language API; Anthropic uses the Messages API. OpenRouter model IDs and metadata come from its live `/models` catalog. Maya only labels a catalog model free when both its prompt and completion prices are explicitly zero; provider quotas, rate limits, and terms still apply. Model lists are fetched from each provider when its server-side key is configured. A provider whose key is missing remains visible and selectable so Maya can show setup instructions, but model discovery and chat fail explicitly without falling back to another provider. Set an `MAYA_ENABLE_*` flag to `false` to disable a provider. Custom cloud endpoints are intentionally not accepted; LM Studio and Ollama have separately validated local endpoint rules. Never place API keys in `NEXT_PUBLIC_*`, chat settings, or frontend files.

When Maya runs directly on Windows, edit only the `DEEPSEEK_API_KEY` line in the existing root `.env` and restart the backend process with `npm run server`. When using Docker Compose, Compose reads the same root `.env` and passes cloud credentials to the `maya` container; after changing it, recreate only Maya:

```powershell
docker compose up -d --build --no-deps maya
```

The Compose service publishes host port `PORT` (default `3000`). If that host port is occupied by the existing host-run Maya backend, do not restart Ollama or Chroma or run a competing backend on that port. Stop the confirmed host Maya process first, or choose another host port and point the frontend proxy at it.

Obtain credentials only from the provider's official account page and set them in the backend `.env` (never in the frontend):

- [OpenAI API keys](https://platform.openai.com/api-keys) → `OPENAI_API_KEY`
- [DeepSeek API keys](https://platform.deepseek.com/api_keys) → `DEEPSEEK_API_KEY`
- [Google AI Studio API keys](https://aistudio.google.com/app/apikey) → `GOOGLE_API_KEY`
- [Anthropic Console API keys](https://console.anthropic.com/settings/keys) → `ANTHROPIC_API_KEY`
- [OpenRouter API keys](https://openrouter.ai/settings/keys) → `OPENROUTER_API_KEY`

### `gpt4free` assessment

Maya does not import, copy, or call the external [`xtekky/gpt4free`](https://github.com/xtekky/gpt4free) project. Its repository is GPL-3.0-licensed and documents a separately hosted FastAPI-compatible service, rather than a Maya-owned integration to the underlying model providers. Provider support and requirements vary; some advertised routes depend on browser automation, cookies, or HAR data. Maya instead calls the providers' documented APIs directly, keeps credentials in the backend environment, and remains independent of any `gpt4free` clone or service. OpenRouter is a separate, direct API integration; it does not depend on `gpt4free`.

In Settings, choose a configured provider, refresh its live model list, select an available chat model, then use **Test connection** and **Test inference**. A reachable provider is not considered inference-ready until the selected model is available; inference is confirmed only after a real, small streaming generation succeeds. `MAYA_PROVIDER_TEST_TIMEOUT_MS` sets the inference diagnostic deadline (default 60000 ms, range 1000–120000 ms); the frontend permits up to 125 seconds. Failed tests show a sanitized diagnostic without credentials or raw upstream response bodies.

Common diagnostics:

- **LM Studio unreachable / connection refused:** start its Local Server in the LM Studio app, verify `127.0.0.1:1234`, then retry. If `Test-NetConnection` fails, the server is not listening; a model name in `.env` does not start LM Studio.
- **Model unavailable:** refresh model IDs and select an exact returned ID. Load the model in LM Studio or install it in Ollama as appropriate.
- **Authentication failed:** validate the server-side API key in `.env`, confirm it belongs to that provider, and restart the API. Never paste cloud keys into Settings.
- **Timeout or provider outage:** check local service/provider status and the configured timeout; do not treat a timeout as a successful connection.
- **Documents unavailable:** ChromaDB is independent of chat. Check its health before using RAG; no connection test or provider change deletes collections or rewrites embeddings.

## Local Development

### Windows with LM Studio

1. Download LM Studio from [lmstudio.ai](https://lmstudio.ai/) and install it using the official Windows installer. Do not bypass Windows security warnings.
2. In LM Studio, search for a reputable 7B–8B coding model in GGUF format. An example candidate is [`bartowski/Qwen2.5-Coder-7B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF), quantization `Q4_K_M`; the published model file metadata lists a size of **4,683,074,336 bytes** (about **4.36 GiB**). This is an expected download size, not evidence that the file is installed or loaded.
3. Check free disk space and the selected file size in LM Studio before downloading; obtain explicit user approval before starting a model download.
4. After the model is downloaded, load it in LM Studio and start its local server bound to loopback. Verify the actual server address and model identifier in LM Studio. The common API base is `http://127.0.0.1:1234/v1`; Maya accepts only loopback hosts and the `/v1` path.
5. In a fresh PowerShell, verify the local API and available models:

```powershell
Invoke-RestMethod http://127.0.0.1:1234/v1/models
```

If that command reports a connection failure, open LM Studio, load the model, open **Developer -> Local Server**, set the server to `127.0.0.1:1234`, and select **Start Server**. Maya cannot start or control the LM Studio desktop application. Check the port and list the verified model IDs again:

```powershell
Test-NetConnection 127.0.0.1 -Port 1234
(Invoke-RestMethod http://127.0.0.1:1234/v1/models).data | Select-Object -ExpandProperty id
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

Only configure `LM_STUDIO_API_KEY` in the backend `.env` if local server authentication is enabled. Keep the key server-side; never enter it in frontend/public environment settings. The adapter sends it only as a bearer token to its validated loopback LM Studio endpoint. The app does not fall back to another provider when LM Studio is down.

Set the exact identifier returned by that endpoint, then run Maya (replace the placeholder with the verified identifier):

```powershell
$env:MAYA_LOCAL_PROVIDER = "lm-studio"
$env:LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1"
$env:LM_STUDIO_MODEL = "<exact-id-from-v1-models>"
npm ci
npm run server
```

The backend binds to `127.0.0.1` by default. Start the frontend separately using the Next.js instructions above. No cloud AI provider is used as a fallback.

Run the backend directly on the same Windows host as LM Studio. The Docker Compose backend cannot use `127.0.0.1:1234` to reach a host LM Studio process, and this adapter intentionally does not allow non-loopback model-server URLs.

### Ollama

Ollama remains available as the default. Install it from its official distribution for your operating system, then run Ollama and download the configured chat model. For Linux, the official install command is:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Start Ollama as your normal user and install the chat and embedding models you intend to use after checking disk space. Replace these placeholders with exact model IDs:

```bash
ollama pull CHAT_MODEL_NAME
ollama pull EMBEDDING_MODEL_NAME
```

In another terminal, install dependencies and start the backend:

```bash
npm ci
npm run server
```

The Express server binds to loopback (`127.0.0.1`) by default. Start the Next.js frontend separately as described above to use the current interface. To use RAG with a native Ollama install, start the bundled local-only Chroma service separately with `docker compose up -d chroma`; it binds to `127.0.0.1:8000` by default. If Chroma is unavailable, ordinary chat remains available and Maya warns that document retrieval is not being used.

If startup reports that port 3000 is already in use, check whether Maya is already running before starting another copy:

```powershell
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3000 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId = <PID>" |
  Select-Object ProcessId, Name, CommandLine
```

If the process is the Maya backend and you need to restart it to load code changes, stop only that confirmed process with `Stop-Process -Id <PID>`, then run `npm run server` again. Do not stop a process until you have verified its command line.

Available scripts:

- `npm run dev`: starts the Next.js frontend on port `3001`
- `npm run server`: starts Express on `HOST` and `PORT`
- `npm test`: runs backend and Next.js frontend tests
- `npm run build`: checks the backend and builds the Next.js frontend
- `npm run evaluate -- --provider <ollama|lm-studio> --model <local-model-id> --dataset training/evaluation-smoke.jsonl`: runs the local keyword smoke evaluation; see the evaluation section below
- `npm start`: starts the production server

## Environment Variables

Copy `.env.example` to `.env`. Important settings:

- `HOST` / `PORT`: backend bind address and port; defaults are `127.0.0.1:3000`.
- `MAYA_LOCAL_PROVIDER`: `ollama` (default) or `lm-studio`; selects the default local provider. Cloud providers are configured separately and must be explicitly selected in Maya.
- `OLLAMA_URL`: private Ollama URL; defaults to `http://127.0.0.1:11434`.
- `OLLAMA_MODEL`: optional exact chat model ID. If unset, Maya discovers installed models and selects an available model in Settings.
- `OLLAMA_EMBEDDING_MODEL`: embedding model, default `nomic-embed-text`. Use the same model for indexing and retrieval; re-upload documents after changing it.
- `OLLAMA_TIMEOUT_MS`: request timeout in milliseconds, default `120000`; configure from `1000` through `600000`.
- `MAYA_PROVIDER_TEST_TIMEOUT_MS`: provider inference diagnostic deadline in milliseconds, default `60000`; configure from `1000` through `120000`.
- `LM_STUDIO_BASE_URL`: loopback-only LM Studio API base, defaults to `http://127.0.0.1:1234/v1`.
- `LM_STUDIO_API_KEY`: optional server-only bearer key when LM Studio local server authentication is enabled; unset by default.
- `LM_STUDIO_MODEL`: optional preferred model ID from LM Studio `/v1/models`; if unset, Maya discovers available IDs and selects one in Settings.
- `LM_STUDIO_TIMEOUT_MS`: LM Studio request timeout in milliseconds, default `120000`; configure from `1000` through `600000`.
- `MAYA_EMBEDDING_PROVIDER`: `ollama` (default) or `lm-studio`. This is independent of the chat provider.
- `LM_STUDIO_EMBEDDING_MODEL`: required for LM Studio embeddings; configure only if an embedding-capable model is loaded and `/v1/embeddings` has been verified.
- `DEEPSEEK_API_KEY`: optional server-only key; enables authenticated DeepSeek model discovery and chat.
- `OPENAI_API_KEY`: optional server-only key; enables OpenAI model discovery and chat.
- `OPENROUTER_API_KEY`: optional server-only key; enables live OpenRouter model-catalog discovery and chat. Its models are not automatically selected as a fallback.
- `MAYA_ENABLE_OPENROUTER`: set to `false` to disable the OpenRouter adapter even when a key is configured; defaults to enabled.
- `GOOGLE_API_KEY`: optional server-only Gemini API key; `GEMINI_API_KEY` is accepted as an alias.
- `ANTHROPIC_API_KEY`: optional server-only key; enables Anthropic model discovery and chat.
- `RAG_EMBEDDING_MODEL`: optional explicit embedding model override. Changing embedding models does not migrate old vectors; re-index documents for consistent retrieval.
- `CHROMA_URL`: local Chroma URL, default `http://127.0.0.1:8000`.
- `RAG_MAX_DISTANCE`: cosine-distance cutoff, default `0.45`. This is a starting point, not an evaluated relevance guarantee; tune it against your own documents and questions.
- `WEB_SEARCH_PROVIDER`: `none` (default) or `brave`.
- `BRAVE_SEARCH_API_KEY`: optional secret needed only for Brave Search.
- `CORS_ORIGINS`: comma-separated exact origins; defaults to local development origins.
- `API_AUTH_TOKEN`: optional bearer token, at least 32 characters. Configure it before exposing the API beyond loopback.
- `MAYA_WORKSPACE_ROOT`: optional explicit local project folder for the user-approved workspace tools. It is not forwarded by the default Docker Compose configuration; see Local Coding Workspace.
- `MAYA_DATA_DIR`: optional local directory for explicit memories and response feedback. By default Maya uses `%LOCALAPPDATA%\Maya AI` on Windows or `$XDG_DATA_HOME/Maya AI` (falling back to `~/.local/share/Maya AI`) elsewhere.
- `MAYA_HOST` / `CHROMA_HOST`: Docker host-published bind addresses; both default to loopback.

### ChromaDB document-storage troubleshooting

The backend exposes a read-only Chroma status check at `GET /api/documents/health`. It checks the Chroma heartbeat and collection API without creating or changing a collection. The Documents panel shows whether Chroma is ready and gives a specific message for a stopped service, a URL that does not answer as Chroma, or a database/initialization failure.

For a native Maya backend on Windows, start Docker Desktop normally, then from the repository directory run:

```powershell
docker compose up -d chroma
Invoke-RestMethod http://127.0.0.1:8000/api/v2/heartbeat
```

The existing Compose service uses the persistent `chroma-data` volume and binds only to `127.0.0.1:8000` by default. Starting the service does not delete or reset that volume. Do not use `docker compose down -v` if you need to preserve Chroma data. In Docker Compose, Maya uses the internal service URL `http://chroma:8000`; when Maya runs directly on Windows, it uses `http://127.0.0.1:8000`.

If Chroma does not become ready, inspect the service and its logs without removing containers or volumes:

```powershell
docker compose ps chroma
docker compose logs --tail 100 chroma
```

These commands require Docker Desktop's Linux Engine to be running. If Docker reports that its engine pipe is unavailable, start Docker Desktop first, then retry `docker compose up -d chroma`.

The system prompt, model, temperature, context size, and output limit are adjustable in Settings and saved with browser settings. Model, context, message, instruction, and request sizes are also bounded on the server.

### Curated fine-tuning data and preflight (no training runtime)

Maya currently provides a **separate, stdlib-only dataset preparation and read-only preflight component**. It does not collect chats, start training, download models, change the active model, or claim a fine-tuning result. Use only examples that you have reviewed and are permitted to train on. Do not include conversations, private documents, credentials, or generated answers that have not been verified. Credential-pattern checks are a safeguard, not a guarantee that private data has been detected.

The canonical JSONL format is one JSON object per line, with a `messages` array containing only `role` and `content` fields. A system message is optional and must be first; user and assistant messages alternate; each example ends with an assistant answer. This is Maya's preparation format, **not a claim of compatibility with an installed training framework**:

```json
{"messages":[{"role":"user","content":"Write a semantic HTML login form."},{"role":"assistant","content":"<form>...</form>"}]}
```

In PowerShell, from the repository root, validate and deduplicate-check a curated file, then make a deterministic train/validation split in a new directory:

```powershell
py -3.12 -m training.dataset validate .\training\datasets\curated.jsonl
py -3.12 -m training.dataset split .\training\datasets\curated.jsonl --output-dir "$env:LOCALAPPDATA\Maya AI\training\dataset-v1" --validation-ratio 0.1 --seed 42
```

The split command refuses to overwrite existing split files. To run the read-only local model/hardware preflight, point it at an existing Hugging Face model directory and the curated dataset:

```powershell
py -3.12 -m training.preflight --dataset "$env:LOCALAPPDATA\Maya AI\training\dataset-v1\train.jsonl" --base-model "D:\models\local-hf-model" --artifact-dir "$env:LOCALAPPDATA\Maya AI\training\artifacts"
```

The preflight checks local tokenizer/weights/configuration, license metadata, free RAM/disk, NVIDIA VRAM when available, and whether the selected Python environment has `torch`, `transformers`, `peft`, and `bitsandbytes`. It does not install missing dependencies. GGUF-only model exports, including models loaded in LM Studio without a separate Hugging Face training directory, are not accepted as fine-tuning inputs. The conservative v1 gate blocks models when NVIDIA VRAM is unknown or below 8 GiB; the RTX 3050 Laptop's approximately 4 GiB therefore does not pass. This does not mean the preflight has validated training compatibility or that CPU/offloaded training is supported.

There is deliberately **no training, adapter activation, or rollback command**. The project has a local smoke-evaluation command, but no verified trainer or held-out quality benchmark, so it must not start a job or recommend/deploy an adapter. The fine-tuning directory only prepares curated datasets and performs a read-only hardware/model preflight; it does not change model weights.

Automatic learning from conversations, candidate-to-verified fact promotion, semantic memory retrieval, and a versioned skill registry are not implemented. Maya does provide the explicit, user-authored memory and response-feedback controls described below. Feedback is not used as training data. Optional cloud-provider routing is implemented below; cloud requests are sent only after explicit provider selection, and there is no cloud fallback.

Maya supports local Ollama or explicitly selected, loopback-only LM Studio inference by default. Optional cloud adapters are described below and are disabled unless configured and selected. There is no automatic external inference fallback. Optional web search is separate and sends a query to the configured external search provider only when the user explicitly enables search. Responses include provider and model metadata. LM Studio embeddings are optional and require a separately verified embedding model; using LM Studio for chat alone does not enable RAG.

### Optional cloud model providers

DeepSeek, OpenAI, Google Gemini, and Anthropic are optional cloud chat providers. No provider key is needed for local use. To enable one, place its key in the **backend** `.env` file (never a `NEXT_PUBLIC_*` setting), then restart Express:

```dotenv
DEEPSEEK_API_KEY=
# Optional alternatives:
# OPENAI_API_KEY=
# GOOGLE_API_KEY=
# ANTHROPIC_API_KEY=
```

In Maya, open **Settings** or select the provider directly in the chat header. Set `DEEPSEEK_API_KEY` in the backend `.env` file and restart Express (`npm run server`) before using DeepSeek. Its chat API uses `https://api.deepseek.com/chat/completions`; the authenticated `/models` catalog supplies the available model IDs. Current DeepSeek documentation lists `deepseek-flash` and `deepseek-v4-pro`; Maya does not hardcode these IDs and uses the live catalog instead. Use **Refresh models**, select a discovered model, then run **Test connection** or **Test inference**. Ollama IDs and tags come from `/api/tags`; LM Studio IDs come from its configured `/v1/models` endpoint. Discovered models are shown as installed/available; a model is marked verified only after its explicit inference test succeeds. If discovery fails, Maya shows the error and does not invent a model list. The current conversation history and prompt will be sent to the cloud provider you selected. Maya warns in the UI and does not attach private Chroma documents or local project notes to cloud requests. There is no automatic cloud fallback. Local inference remains the default.

DeepSeek uses its OpenAI-compatible API (`https://api.deepseek.com`); OpenAI uses `https://api.openai.com/v1`; Gemini uses Google's Generative Language REST API; Anthropic uses its Messages and Models REST APIs. Cloud-provider network access and a valid account/API key are required. Provider errors are sanitized and keys are never returned by provider discovery APIs.

### Explicit memory and response feedback

Open **Settings → Approved memories** to create, edit, or delete memories. Creating or editing a memory is an explicit user action; no chat, model answer, feedback vote, or uploaded document is automatically promoted to memory. Maya retrieves up to five memories by bounded keyword overlap only when **Use only memories I explicitly save in local chats** is enabled. That opt-in defaults off. Memories are added as contextual data, not system instructions, and are never attached to cloud-provider requests.

Thumbs-up/down votes explicitly store response feedback. Click the selected vote again to remove it. Maya persists only the response and conversation IDs, rating, provider/model, and timestamps; it does not store the prompt or assistant response in the feedback record. Feedback is not used to change model weights or train a model.

The backend stores these records as local JSON in `MAYA_DATA_DIR\learning.json` using atomic replacement. The file is plaintext and must be protected by the operating-system account and disk permissions; configure a private local directory, do not sync it to a shared location, and do not save credentials, secrets, or private document excerpts as memories. Heuristic credential checks reject common secret patterns but cannot identify every sensitive value. Existing files are never silently reset when unreadable or corrupt.

### Document retrieval and source grounding

An upload is an explicit user action that extracts, chunks, embeds locally, and indexes supported documents in the existing Chroma collection. There is no extracted-text preview or per-passage approval step: uploading a file approves indexing that file, not the truth of its contents. Maya retrieves up to five nearby passages for local chat, forwards them as evidence with document/passage references, and shows those references with the response. The model is instructed to treat excerpts as untrusted evidence, not executable instructions. This is retrieval grounding, not factual verification: relevance thresholds are heuristic, prompt injection cannot be eliminated, and users should review the cited passages. Cloud chat does not receive local document passages or personal memories. Existing Chroma collections and volumes are not reset by this feature.

### Repeatable local smoke evaluation

`training/evaluation-smoke.jsonl` is a small, version-controlled prompt set with required output terms. Run it against a selected local provider/model while the Maya backend is running:

```powershell
npm run evaluate -- --provider lm-studio --model google/gemma-4-e4b --dataset training/evaluation-smoke.jsonl --output "$env:LOCALAPPDATA\Maya AI\evaluations\gemma-baseline.json"
```

Run the same dataset and command again with the candidate model and a different output filename, then compare the reports:

```powershell
npm run evaluate -- --compare "$env:LOCALAPPDATA\Maya AI\evaluations\gemma-baseline.json" "$env:LOCALAPPDATA\Maya AI\evaluations\gemma-candidate.json"
```

For Ollama, pass `--provider ollama --model <verified-local-model-id>`. If backend token authentication is enabled, set `MAYA_API_TOKEN` in the shell that runs evaluation. `MAYA_EVALUATION_API_URL` may override the local API address but is restricted to loopback. Reports contain dataset hash, model/provider, required-term matches, pass rate, and latency—not generated answers. The report command refuses to overwrite an existing report. This smoke test is repeatable but is not a comprehensive quality/safety benchmark, and keyword matches are not proof of correctness.

## Local Coding Workspace

The coding workspace is an optional, user-driven local tool panel. It is disabled until the Node/Express server is given one explicit workspace root. In PowerShell, configure the folder before starting the backend:

```powershell
$env:MAYA_WORKSPACE_ROOT = "C:\Users\You\source\my-project"
npm run server
```

Or add `MAYA_WORKSPACE_ROOT=C:\Users\You\source\my-project` to the backend `.env` file. Restart the backend after changing it. The configured root is not returned to the browser; the UI receives only the folder name and a non-reversible project identifier. The workspace tools can browse folders, read text files, search code, keep project notes in browser storage, propose file changes, and display before/after content. A separate **Approve and apply** action is required to write a proposed change. Proposals expire after ten minutes and are rejected if the target file changed in the meantime.

The panel can run only the workspace's existing `npm run test`, `npm run lint`, `npm run typecheck`, or `npm run build` script. Each run requires a browser confirmation and has a five-minute timeout and a one-megabyte output cap. These are project-defined scripts and may execute code; review the project and approve only if you trust it. Maya does not install packages, elevate privileges, run arbitrary model-generated commands, or expose a general-purpose terminal. Workspace access is disabled by default, confined to the configured root, and denies symlinks, common credential/configuration paths, binary files, and oversized text files. Set a strong `API_AUTH_TOKEN` and keep the server on loopback; do not expose workspace APIs to an untrusted network.

For Docker, workspace access is deliberately not mounted or enabled by the default Compose file. If you need it in a container, explicitly add a read/write bind mount for only the intended project and set `MAYA_WORKSPACE_ROOT` to its **container path**. Do not mount a home directory, secrets folder, or broad filesystem tree.

This is not yet a fully autonomous coding agent: model-driven tool calling/planning, multi-step task tracking, isolated website preview, and ZIP export are not implemented. File proposals are user-authored through the workspace editor, not automatically generated or applied by the model.

## Docker Development

The Compose stack runs the Express API, Ollama, and ChromaDB. Ollama is reachable only on the private Compose network and is not published to the host. Chroma's host port and the API's host port bind to loopback by default. Model and vector data use named Docker volumes, not Git. Run the Next.js frontend separately with `npm run dev`, then open `http://localhost:3001`.

Replace these placeholders with exact model IDs:

```bash
docker compose up --build -d

docker compose exec ollama ollama pull CHAT_MODEL_NAME
docker compose exec ollama ollama pull EMBEDDING_MODEL_NAME
# In another terminal, run npm run dev and open http://localhost:3001
```

Check the services:

```bash
docker compose ps
curl http://localhost:3000/api/health
curl http://127.0.0.1:3000/api/documents/health
```

Stop the stack:

```bash
docker compose down
```

For NVIDIA container GPU acceleration, install the NVIDIA Container Toolkit and enable the commented device reservation in `docker-compose.yml` on the GPU host. Docker cannot provide an NVIDIA GPU inside ordinary GitHub-hosted runners. Do not add a public port mapping for Ollama or Chroma.

Build only the Maya image:

```bash
docker build -t maya-local-llm .
docker run --rm -e HOST=0.0.0.0 -p 127.0.0.1:3000:3000 --env-file .env maya-local-llm
```

## GitHub Codespaces

1. Push the repository to GitHub.
2. Open the repository and choose **Code -> Codespaces -> Create codespace on main**.
3. Codespaces automatically uses `.devcontainer/devcontainer.json`.
4. Dependencies install through `npm ci`; JavaScript validation runs after container start.
5. Run `npm run server` for the backend and `npm run dev` for Next.js; open forwarded port `3001` from the Ports panel.

Codespaces is suitable for frontend/backend development and tests. It normally does not provide an NVIDIA GPU. Keep inference on a local machine or secured private network; LM Studio URLs configured in Maya are restricted to loopback. Do not expose either local model server publicly.

## Chat, Documents, and Search

- `GET /api/health`: reports the selected local runtime and loaded/installed model names
- `GET /api/models`: lists installed local models
- `GET /api/documents`, `POST /api/documents`, `DELETE /api/documents/:id`: manage local TXT, Markdown, and PDF documents
- `POST /api/chat`: accepts `{ message, conversation, model, temperature, context, maxTokens, systemPrompt, webSearch }` and returns an SSE stream
- `/api/workspace/*`: optional root-confined file browsing, search, proposed edits, and user-approved npm checks; disabled unless the server is configured with `MAYA_WORKSPACE_ROOT`

The browser buffers streamed tokens and updates the active response about every 75 ms. Stop Generation aborts the request through to the configured local runtime. Maya includes conversation rename/delete, retry/regenerate, model discovery, Markdown formatting, escaped code highlighting, and copy controls.

Uploads are limited to 10 MB per file and to TXT, Markdown, or PDF. PDF support extracts embedded text only; scanned PDFs need OCR, which is not included. Text is chunked locally and embedded using the configured local embedding provider before it is stored in Chroma. Document excerpts and web snippets are treated as untrusted evidence, not instructions. Maya displays retrieved file/chunk references and links returned by the web provider and is instructed to cite only those sources; model-generated answers still require verification.

Web search requires configuring `WEB_SEARCH_PROVIDER=brave` and `BRAVE_SEARCH_API_KEY`. It is an optional external service: only queries sent with the **Search web** toggle enabled are sent to Brave. Chat inference remains on the selected local model runtime.

## Tests and CI

Run locally:

```bash
npm run build
npm test
```

`.github/workflows/ci.yml` runs on pushes to `main` and pull requests. It installs both dependency sets, runs backend/frontend checks and tests, and verifies the Docker build. It does not download models or call an AI service.

Dependabot checks npm and GitHub Actions dependencies weekly.

## Deployment

A hosted deployment has three parts:

```text
Next.js host -> Express API host -> Ollama on a GPU or CPU host
                                  -> selected Ollama model volume
```

Recommended options:

1. **Next.js host plus API host:** deploy `frontend/` to a Node.js-capable Next.js host. Set `MAYA_API_ORIGIN` to the Express API origin for the server-side proxy, or set `NEXT_PUBLIC_API_BASE_URL` to the API's `/api` URL and allow the frontend's exact origin in `CORS_ORIGINS`.
2. **Single GPU server:** run the Next.js frontend and Express API behind a TLS reverse proxy, set a strong `API_AUTH_TOKEN`, and keep Ollama and ChromaDB private.
3. **Separate services:** run the Node/Express container on a server and set `OLLAMA_URL` and `CHROMA_URL` to private endpoints. Restrict those service ports with a firewall or private network.
4. **Codespaces development:** use Codespaces for code and tests, but keep inference on a separate machine.

Set the backend to require `API_AUTH_TOKEN` when exposed beyond a trusted local network. Keep the token server-side and never put it in `NEXT_PUBLIC_*` variables. For a direct browser-to-API connection, set the backend's `CORS_ORIGINS` to the exact deployed frontend origin. For the server-side Next.js proxy, configure `MAYA_API_ORIGIN` in the Next.js host environment.

```env
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=
API_AUTH_TOKEN=<a randomly generated secret of at least 32 characters>
```

Generate a token with `openssl rand -hex 32` and store it only in the backend environment. Keep Ollama and Chroma private, publish the frontend and authenticated API through HTTPS, and do not use the example token placeholder as a real value. The backend's OPTIONS handler allows preflight for configured origins. Test a direct API deployment with:

```bash
curl -i -X OPTIONS https://YOUR-BACKEND-DOMAIN.example.com/api/chat \
    -H 'Origin: https://YOUR-FRONTEND-DOMAIN.example.com' \
    -H 'Access-Control-Request-Method: POST'

curl -N https://YOUR-BACKEND-DOMAIN.example.com/api/chat \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer YOUR_API_AUTH_TOKEN' \
    -d '{"message":"Hello"}'
```

`.github/workflows/deploy.yml` is a manual SSH deployment template. Configure these GitHub Environment secrets before using it:

- `DEPLOY_HOST`
- `DEPLOY_PORT` (optional)
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`
- `DEPLOY_ENV_FILE` containing the deployment environment file

The target host must already have Docker, Docker Compose, Git, and access to the required GPU runtime if GPU acceleration is desired. Review the workflow and secure the host before enabling production deployment.

## Security and Limitations

- All chat history is stored in the browser's local storage; it is not a server database.
- Workspace project notes are stored in browser local storage keyed by a server-generated workspace identifier; they are not encrypted. Notes are included in local chat prompts.
- Workspace package scripts execute as the Maya server's OS user and are not sandboxed. The UI requires confirmation for each run, strips common secret environment variables, bounds runtime/output, and redacts common credential patterns, but only run checks for projects you trust.
- The coding workspace is an opt-in single-root feature, not a model-connected autonomous agent. It has no project-specific RAG isolation, generated-site preview, archive export, or multi-user workspace access controls.
- Generated HTML and Markdown are escaped; Maya never injects model-generated HTML as executable page markup.
- The default Node bind and Docker host ports are loopback-only. Ollama has no public Docker port mapping; Chroma is loopback-only by default. LM Studio is configured through a strict loopback-only API base.
- Optional bearer-token authentication protects API routes; use HTTPS and a strong token before public access. It is single-token access, not multi-user authorization or account management.
- In-memory rate limits reset when the server restarts and are not shared across multiple backend replicas.
- Chat history is browser-local and is not encrypted or synchronized. Do not store highly sensitive material in the browser if the device profile is shared.
- Uploaded files are processed in memory; extracted chunks and embeddings persist in Chroma's local volume. Back up or delete that volume deliberately.
- RAG relevance depends on the embedding model, chunking, and distance threshold; retrieval quality has not been evaluated against a benchmark.
- The Markdown and code highlighter are lightweight local implementations, not a full CommonMark/GFM parser or compiler.
- Brave Search is external and receives queries only when explicitly enabled. All model inference and document processing use local services.
- Model loading can take time on first request. Keep the selected local runtime running; Docker Ollama models use a persistent model volume.
- A 4 GB GPU may require CPU fallback or smaller models if context/output settings are increased. The default limits are conservative, not a performance guarantee.
- GitHub Actions verifies code and the image but does not run Qwen or Chroma-backed integration tests.
