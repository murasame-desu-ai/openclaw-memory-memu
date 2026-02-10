# openclaw-memory-memu

OpenClaw memory plugin using the [memU](https://github.com/murasame-desu-ai/memU) framework (fork with Anthropic/Gemini multi-provider support).

Provides long-term memory for OpenClaw agents: auto-capture conversations, recall relevant context, and manage memories through agent tools.

## Quick Start

### 1. Install the forked memU

> **Important:** The original memU does not support Anthropic/Gemini providers. You must use the fork.

```bash
git clone https://github.com/murasame-desu-ai/memU.git
cd memU
pip install -e .
```

### 2. Install the plugin

```bash
cd ~/.openclaw/extensions/
git clone https://github.com/murasame-desu-ai/openclaw-memory-memu.git memory-memu
cd memory-memu
npm install
npm run build
```

### 3. Add to OpenClaw config

Add to `openclaw.json` → `plugins.entries`:

```jsonc
{
  "memory-memu": {
    "path": "~/.openclaw/extensions/memory-memu",
    "config": {
      "geminiApiKey": "AIza..."   // Required: get from https://aistudio.google.com/apikey
      // anthropicToken is auto-resolved from OpenClaw auth — no manual setup needed
    }
  }
}
```

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

That's it. The plugin will auto-capture conversations and auto-recall relevant memories.

### Verify

```bash
# Direct wrapper test:
cd ~/.openclaw/extensions/memory-memu
ANTHROPIC_TOKEN="sk-ant-..." GEMINI_API_KEY="AIza..." \
  python3 memu_wrapper.py list
```

## How It Works

```
User message → [Auto-Recall] search memories → inject relevant context
                                                    ↓
Agent processes message with memory context → generates response
                                                    ↓
Agent turn ends → [Auto-Capture] summarize conversation → store memory
```

### Auto-Recall (`before_agent_start`)

Before each agent turn, the plugin searches for memories related to the user's prompt and injects them as `<relevant-memories>` context. This gives the agent access to past conversations and facts without manual lookup.

### Auto-Capture (`agent_end`)

After each successful agent turn, the plugin extracts the current conversation turn (last user + assistant messages, with 2 messages of prior context), summarizes it via LLM, and stores it as a memory item.

### Periodic Cleanup

On each `agent_end`, the plugin checks if enough time has passed since the last cleanup. If so, it removes old unreinforced memories automatically.

## Architecture

```
index.ts (OpenClaw plugin)
    ↓ subprocess
memu_wrapper.py (Python bridge)
    ↓ imports
memU MemoryService (Python library)
    ↓
SQLite database (~/.openclaw/memory/memu.sqlite)
```

The TypeScript plugin communicates with the Python memU library via a subprocess wrapper (`memu_wrapper.py`). Each tool call or lifecycle hook spawns a Python process with the appropriate command and environment variables.

## Authentication

### Anthropic Token Resolution

The plugin automatically resolves the Anthropic API token in this order:

1. **OpenClaw auth profiles** (recommended): Reads `~/.openclaw/agents/main/agent/auth-profiles.json` → uses the `lastGood.anthropic` profile's token
2. **Any Anthropic profile**: Falls back to any profile starting with `anthropic:` in auth-profiles.json
3. **Static config**: Uses the `anthropicToken` value from plugin config as final fallback

This means if OpenClaw's built-in authentication is active, **the plugin picks up the token automatically** — no manual configuration needed.

### Gemini API Key

The `geminiApiKey` must be set explicitly in the plugin config. Get one from [Google AI Studio](https://aistudio.google.com/apikey).

## Tools

| Tool | Description |
|------|-------------|
| `memory_memorize` | Ingest a resource (file/URL/image) through the full memU pipeline: ingest → extract → embed → store |
| `memory_list` | List recent memories sorted by creation date (newest first) |
| `memory_delete` | Delete a specific memory by UUID |
| `memory_categories` | List all memory categories with descriptions and summaries |
| `memory_cleanup` | Remove old unreinforced memories older than N days |

## Memory Categories

The plugin creates 4 default categories:

| Category | Description |
|----------|-------------|
| User Profile | User information and identity |
| Preferences | User preferences and settings |
| Facts | Important facts and knowledge |
| Events | Notable events and occurrences |

Category summaries are generated automatically by memU's LLM as memories accumulate in each category.

## Config

```jsonc
// openclaw.json → plugins.entries.memory-memu.config
{
  // --- Authentication ---
  "anthropicToken": "sk-ant-...",   // Auto-resolved from OpenClaw auth if omitted
  "geminiApiKey": "AIza...",        // Required: Gemini API key for embeddings

  // --- Feature Toggles ---
  "autoCapture": true,              // Auto-capture conversations (default: true)
  "autoRecall": true,               // Auto-inject relevant memories (default: true)

  // --- LLM Provider ---
  "llmProvider": "anthropic",       // "anthropic" | "openai" | "gemini" (default: "anthropic")
  "llmBaseUrl": "",                 // Custom API base URL (uses provider default if empty)
  "llmModel": "",                   // Chat model (default: claude-haiku-4-5 for anthropic)

  // --- Embedding Provider ---
  "embedProvider": "gemini",        // "gemini" | "openai" (default: auto based on llmProvider)
  "embedBaseUrl": "",               // Custom embedding API URL
  "embedModel": "",                 // Embedding model (default: gemini-embedding-001)

  // --- Retrieval Settings ---
  "routeIntention": true,           // LLM judges if retrieval is needed & rewrites query (default: true)
  "sufficiencyCheck": true,         // LLM checks if results are sufficient (default: true)
  "rankingStrategy": "salience",    // "similarity" | "salience" (default: "salience")
  "recencyDecayDays": 30,           // Half-life for recency scoring in salience ranking (default: 30)

  // --- Memorization Settings ---
  "enableReinforcement": true,      // Track repeated info with higher weight (default: true)
  "categoryAssignThreshold": 0.25,  // Auto-categorization confidence threshold 0-1 (default: 0.25)

  // --- Maintenance ---
  "cleanupMaxAgeDays": 90,          // Delete unreinforced memories older than N days (default: 90)
  "cleanupIntervalHours": 24,       // How often to run cleanup, 0 = disabled (default: 24)

  // --- Advanced ---
  "pythonPath": "python3",          // Python interpreter path (default: python3)
  "memuPath": ""                    // Path to memU source, if not pip-installed
}
```

### LLM Provider Defaults

| Provider | Base URL | Default Model | Backend |
|----------|----------|---------------|---------|
| `anthropic` | `https://api.anthropic.com` | `claude-haiku-4-5` | httpx |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | sdk |
| `gemini` | `https://generativelanguage.googleapis.com` | `gemini-2.0-flash` | httpx |

### Embedding Provider Defaults

| Provider | Base URL | Default Model |
|----------|----------|---------------|
| `gemini` | `https://generativelanguage.googleapis.com` | `gemini-embedding-001` |
| `openai` | `https://api.openai.com/v1` | `text-embedding-3-small` |

## Image Memorization

Gemini's `gemini-embedding-001` only accepts text input. Images go through a fallback pipeline:

1. memU's `memorize()` pipeline attempts to process the image
2. If the embedding API rejects it (400 error), the fallback kicks in:
   - Claude Vision describes the image
   - The text description + user-provided context is embedded and stored
3. Image search works via text descriptions, not raw pixel embeddings

For true multimodal vector search, you'd need a multimodal embedding model like Vertex AI `multimodalembedding` or Cohere `embed-v4.0`.

## Database

Memories are stored in SQLite at `~/.openclaw/memory/memu.sqlite`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: memu` | memU not installed or using original | Install the fork: `pip install -e .` |
| `anthropic provider not found` | Using original memU | Switch to fork |
| `GEMINI_API_KEY not set` | Missing Gemini key | Get one from [AI Studio](https://aistudio.google.com/apikey) |
| Embedding quota exceeded | Gemini free tier daily limit | Wait for reset or upgrade to paid |
| Token expired | OpenClaw auth expired | Re-auth with `openclaw auth` |

## Building

```bash
npm run build    # tsc → index.js + index.d.ts
npm run dev      # tsc --watch
```

Build artifacts (`*.js`, `*.d.ts`) are gitignored. OpenClaw loads the TypeScript source directly via the `openclaw.extensions` field in `package.json`.

## Limitations

- **Text-only embeddings**: Image/binary content is converted to text descriptions first. Visual similarity search is not supported.
- **LLM-dependent summarization**: Auto-capture summarizes via LLM, adding latency and cost. Nuances may be lost.
- **No deduplication across sessions**: Duplicate check uses vector similarity (>0.95), which may miss semantically similar but differently worded memories.
- **Gemini embedding quota**: Free tier has daily limits. Heavy usage can exhaust the quota, blocking all memory operations until reset.
- **Single embedding space**: All memories share one vector space — no separate spaces for different modalities or categories.
- **Subprocess overhead**: Each memory operation spawns a Python process. Not ideal for high-frequency calls.

## Requirements

- Python 3.13+ with [forked memU](https://github.com/murasame-desu-ai/memU) installed
- Node.js / TypeScript (for building the plugin)
- OpenClaw with plugin SDK

## License

MIT
