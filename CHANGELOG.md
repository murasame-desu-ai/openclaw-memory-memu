# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-25

### Added

- Korean query preprocessing with stopword removal for better recall ([#2](https://github.com/murasame-desu-ai/openclaw-memory-memu/pull/2))
- Pre-retrieval noise filtering to improve recall quality ([#1](https://github.com/murasame-desu-ai/openclaw-memory-memu/pull/1))
- Unit tests for query preprocessing (`test_preprocess.py`)
- `install.sh` script for one-line installation from GitHub Releases
- GitHub Actions release workflow (triggers on `v*` tag push)
- `CHANGELOG.md`

### Changed

- `shouldCapture()` now also filters short and JSON-only content before LLM judgment
- Search queries are preprocessed (stopword removal) before hitting the embedding API

## [0.1.0] - 2026-02-13

### Added

- Initial release of openclaw-memory-memu plugin
- Auto-recall: search and inject relevant memories before each agent turn
- Auto-capture: summarize and store conversations after each agent turn
- Periodic cleanup of old unreinforced memories
- Multi-provider LLM support (Anthropic, OpenAI, Gemini)
- Gemini embeddings with free-tier support
- SQLite-backed memory storage via memU framework
- Image memorization with Claude Vision fallback
- LLM-based importance judgment and deduplication
- Configurable capture detail levels (low / medium / high)
- Salience-based ranking with recency decay and reinforcement
- Pre-retrieval route intention and sufficiency check
- Agent tools: `memory_memorize`, `memory_list`, `memory_delete`, `memory_categories`, `memory_cleanup`
- Automatic Anthropic token resolution from OpenClaw auth profiles
- `openclaw.plugin.json` config schema with UI hints
- Comprehensive README with Quick Start, config reference, and troubleshooting

[0.2.0]: https://github.com/murasame-desu-ai/openclaw-memory-memu/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/murasame-desu-ai/openclaw-memory-memu/releases/tag/v0.1.0
