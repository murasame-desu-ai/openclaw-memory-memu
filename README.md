# openclaw-memory-memu

OpenClaw memory plugin using [memU](https://github.com/MashiroSA/memu) framework.

Anthropic Claude for LLM + Gemini for text embeddings.

## Features

- **Auto-capture**: Automatically extracts and stores important information from conversations
- **Auto-recall**: Injects relevant memories into context before agent starts
- **Semantic search**: Vector-based memory retrieval using Gemini embeddings
- **Salience ranking**: Combines similarity, recency, and reinforcement for ranking
- **Resource memorization**: Store text files, web pages, and images as memories
- **Periodic cleanup**: Automatically removes old unreinforced memories

## Image Memorization

Gemini embedding API (`gemini-embedding-001`) only accepts text input, so images go through a fallback pipeline:

1. memU's `memorize()` pipeline attempts to process the image
2. If the embedding API rejects it (400 error), the fallback kicks in:
   - Claude Vision describes the image
   - The text description + user-provided context is embedded and stored
3. This means image search works via text descriptions, not raw pixel embeddings

For true multimodal vector search (image↔text in same space), you'd need a multimodal embedding model like Vertex AI `multimodalembedding` or Cohere `embed-v4.0`.

## Tools

| Tool | Description |
|------|-------------|
| `memory_memorize` | Ingest a resource (file/URL/image) into memory |
| `memory_list` | List recent memories |
| `memory_delete` | Delete a specific memory by ID |
| `memory_categories` | List memory categories |
| `memory_cleanup` | Remove old unreinforced memories |

## Config

```jsonc
// openclaw.json → plugins.entries.memory-memu.config
{
  "anthropicToken": "sk-ant-...",   // Required: Anthropic API token
  "geminiApiKey": "AIza...",        // Required: Gemini API key for embeddings
  "autoCapture": true,              // Auto-capture from conversations
  "autoRecall": true,               // Auto-inject relevant memories
  "llmProvider": "anthropic",       // LLM provider: anthropic | openai | gemini
  "llmModel": "claude-haiku-4-5",  // Chat model for summarization
  "embedProvider": "gemini",        // Embedding provider: gemini | openai
  "embedModel": "gemini-embedding-001",
  "rankingStrategy": "salience",    // similarity | salience
  "recencyDecayDays": 30,           // Half-life for recency scoring
  "cleanupMaxAgeDays": 90,          // Auto-cleanup threshold
  "cleanupIntervalHours": 24        // Cleanup frequency (0 = disabled)
}
```

## License

MIT
