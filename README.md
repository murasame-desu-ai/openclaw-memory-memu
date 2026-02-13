# openclaw-memory-memu

OpenClaw memory plugin using the [memU](https://github.com/murasame-desu-ai/memU) framework (fork with Anthropic/Gemini multi-provider support).

Provides long-term memory for OpenClaw agents: auto-capture conversations, recall relevant context, and manage memories through agent tools.

## Prerequisites

- **Python 3.13+** (`python3 --version` to check)
- **Node.js 18+** with npm (`node --version`)
- **OpenClaw** installed and running
- **Gemini API key** — free from [Google AI Studio](https://aistudio.google.com/apikey)

## Quick Start

### 1. Install the forked memU

> **⚠️ You must use the fork, not the original memU.** The original does not support Anthropic/Gemini providers and will not work with this plugin.

```bash
git clone https://github.com/murasame-desu-ai/memU.git
cd memU
pip install -e .

# Verify installation:
python3 -c "from memu.app import MemoryService; print('OK')"
```

### 2. Install the plugin

```bash
# Create extensions directory if it doesn't exist
mkdir -p ~/.openclaw/extensions

# Clone and build
cd ~/.openclaw/extensions/
git clone https://github.com/murasame-desu-ai/openclaw-memory-memu.git memory-memu
cd memory-memu
npm install
npm run build
```

### 3. Add to OpenClaw config

Open your OpenClaw config file (typically `~/.openclaw/openclaw.json` or run `openclaw config path` to find it).

Add the plugin configuration. **Do not replace your existing config** — merge these sections into your existing config:

```jsonc
{
  "plugins": {
    // ⚠️ IMPORTANT: This line activates the plugin as the memory backend!
    "slots": {
      "memory": "memory-memu"
    },
    
    "entries": {
      // ... your existing plugins stay here ...

      "memory-memu": {
        "enabled": true,
        "config": {
          "geminiApiKey": "YOUR_GEMINI_API_KEY_HERE"
          // That's it! Anthropic token is auto-resolved from OpenClaw's own auth.
          // See the Authentication section below for details.
        }
      }
    }
  }
}
```

> **⚠️ Don't forget `plugins.slots.memory`!** Without this line, the plugin will be installed but not used as the memory backend.

**Minimum required config is just `geminiApiKey`.** All other options have sensible defaults. See the [full Config reference](#config) below for advanced options.

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

Done! The plugin will now:
- **Auto-recall**: Search relevant memories before each agent turn and inject them as context
- **Auto-capture**: Summarize and store important information after each agent turn
- **Periodic cleanup**: Remove old unreinforced memories automatically

### 5. Verify it works

Option A — Check OpenClaw logs for:
```
memory-memu: initialized (Anthropic LLM + Gemini embeddings)
```

Option B — Test the Python wrapper directly:
```bash
cd ~/.openclaw/extensions/memory-memu
ANTHROPIC_TOKEN="your-token" GEMINI_API_KEY="your-key" \
  python3 memu_wrapper.py list
# Should output: {"success": true, "count": 0, "total": 0, "items": []}
```

Option C — Chat with your agent and ask: "What do you remember about me?"
After a few conversations, the agent should start recalling past context automatically.

## Example Usage

Here's what the plugin does behind the scenes:

**Day 1 - Initial conversation:**
```
You: I prefer working late at night, around 2-3 AM.
Agent: Got it! [Plugin auto-captures: "User prefers working late at night, 2-3 AM"]
```

**Day 3 - Agent recalls automatically:**
```
You: Should I start that new project now?
Agent: [Plugin auto-recalls: "User prefers working late at night, 2-3 AM"]
       Given your late-night work preference, you might want to wait until 
       later tonight when you're most productive.
```

**Using tools explicitly:**
```
You: Remember this: my dog's name is Moka, she's a Shiba Inu.
Agent: I'll memorize that for you.
       [Uses memory_memorize tool → stores with context]

You: What do you remember about my pets?
Agent: [Uses memory_list tool]
       I remember Moka, your Shiba Inu!
```

**Image memorization:**
```
You: [Sends a photo of a lakeside sunset]
     Remember this place, it's where I go hiking.
Agent: [Plugin uses Claude Vision to describe the image]
       [Stores: "Lakeside sunset location where user goes hiking"]
       
Later...
You: Where was that hiking spot I showed you?
Agent: [Retrieves: "Lakeside sunset location..."]
       The lakeside with the beautiful sunset view!
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
  "recallTopK": 3,                  // Number of memories to retrieve per recall (default: 3)
  "rankingStrategy": "salience",    // "similarity" | "salience" (default: "salience")
  "recencyDecayDays": 30,           // Half-life for recency scoring in salience ranking (default: 30)

  // --- Capture Settings ---
  "captureDetail": "medium",        // "low" | "medium" | "high" — how aggressively to capture (default: "medium")
  "enableReinforcement": true,      // Track repeated info with higher weight (default: true)
  "categoryAssignThreshold": 0.25,  // Auto-categorization confidence threshold 0-1 (default: 0.25)

  // --- Maintenance ---
  "cleanupMaxAgeDays": 90,          // Delete unreinforced memories older than N days (default: 90)
  "cleanupIntervalHours": 0,        // How often to run cleanup, 0 = disabled (default: 0)

  // --- Advanced ---
  "pythonPath": "python3",          // Python interpreter path (default: python3)
  "memuPath": ""                    // Path to memU source, if not pip-installed
}
```

### Config Option Details

#### Feature Toggles

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoCapture` | boolean | `true` | Automatically capture and store important information after each agent turn. When disabled, memories are only created via the `memory_memorize` tool. |
| `autoRecall` | boolean | `true` | Automatically search and inject relevant memories before each agent turn. When disabled, the agent can still use `memory_list` to manually browse memories. |

#### LLM Provider

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `llmProvider` | string | `"anthropic"` | Which LLM provider to use for summarization, importance judgment, and query rewriting. Options: `"anthropic"`, `"openai"`, `"gemini"`. |
| `llmBaseUrl` | string | `""` | Custom API base URL. Leave empty to use the provider's default endpoint. Useful for proxies or self-hosted models. |
| `llmModel` | string | `""` | Specific model name to use. Leave empty for provider defaults (see table below). |

#### Embedding Provider

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedProvider` | string | `"gemini"` | Which provider to use for text embeddings. Options: `"gemini"`, `"openai"`. Gemini offers free-tier embeddings. |
| `embedBaseUrl` | string | `""` | Custom embedding API URL. Leave empty for provider defaults. |
| `embedModel` | string | `""` | Specific embedding model. Leave empty for defaults (see table below). |

#### Retrieval Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `routeIntention` | boolean | `true` | Before searching, an LLM judges whether retrieval is actually needed and rewrites the query for better results. Adds ~1s latency but improves relevance. **Disable if using slang/nicknames that the LLM misinterprets.** |
| `sufficiencyCheck` | boolean | `true` | After retrieval, an LLM checks if the results are sufficient or if a follow-up search is needed. Adds latency but can improve recall quality. |
| `recallTopK` | number | `3` | How many memory items to retrieve and inject per recall. Higher values provide more context but increase prompt token usage. Recommended: 3–5 for chat, 5–10 for complex tasks. |
| `rankingStrategy` | string | `"salience"` | How to rank search results. `"similarity"`: pure vector cosine similarity. `"salience"`: combines similarity with recency decay and reinforcement count for time-aware ranking. |
| `recencyDecayDays` | number | `30` | Half-life in days for recency scoring (only used with `"salience"` ranking). A value of 30 means a 30-day-old memory scores ~50% of a fresh one. Lower = prefer recent memories more aggressively. |

#### Capture Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `captureDetail` | string | `"medium"` | Controls how aggressively the LLM filter captures memories. **`"low"`**: Only critical identity info, major decisions, milestones. **`"medium"`**: Identity, preferences, projects, events, lessons learned. **`"high"`**: All of the above plus casual mentions revealing personality, group chat dynamics, small details like pet names, food preferences, recurring jokes. |
| `enableReinforcement` | boolean | `true` | When storing a new memory, check if a similar one already exists (>0.95 cosine similarity). If so, increment its reinforcement count instead of creating a duplicate. Reinforced memories rank higher in salience search and resist cleanup. |
| `categoryAssignThreshold` | number | `0.25` | Confidence threshold (0–1) for auto-assigning memories to categories. Lower = more memories get categorized; higher = only high-confidence assignments. |

#### Maintenance

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cleanupMaxAgeDays` | number | `90` | When cleanup runs, delete unreinforced memories older than this many days. Reinforced memories (repeated information) are never auto-deleted. |
| `cleanupIntervalHours` | number | `0` | How often (in hours) to auto-run cleanup after agent turns. `0` = disabled (manual only via `memory_cleanup` tool). Set to `24` for daily cleanup. |

#### Advanced

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pythonPath` | string | `"python3"` | Path to Python interpreter. Change if using a virtualenv or specific Python version. |
| `memuPath` | string | `""` | Path to memU source directory, if not installed via pip. The wrapper will add this to `PYTHONPATH`. |

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
