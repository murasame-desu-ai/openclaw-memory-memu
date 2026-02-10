#!/usr/bin/env python3
"""
memU wrapper for OpenClaw plugin.
Called via subprocess from TypeScript plugin.

Commands:
  store <json>   - Store a memory
  search <query> - Search memories
  
Environment:
  ANTHROPIC_TOKEN - Anthropic OAuth token
  GEMINI_API_KEY  - Gemini API key
  MEMU_PATH       - Path to memU source (optional)
"""
import asyncio
import json
import os
import sys

# Add memU to path (only needed if using local source instead of pip install)
memu_path = os.environ.get("MEMU_PATH", "")
if memu_path:
    sys.path.insert(0, memu_path)

from memu.app import MemoryService

# Configuration from environment
ANTHROPIC_TOKEN = os.environ.get("ANTHROPIC_TOKEN", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
DB_PATH = os.environ.get("MEMU_DB_PATH", os.path.expanduser("~/.openclaw/memory/memu.sqlite"))

# Provider settings (configurable via openclaw.json)
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "")
EMBED_PROVIDER = os.environ.get("EMBED_PROVIDER", "")
EMBED_BASE_URL = os.environ.get("EMBED_BASE_URL", "")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "")

# Provider defaults
PROVIDER_DEFAULTS = {
    "anthropic": {"base_url": "https://api.anthropic.com", "model": "claude-haiku-4-5", "backend": "httpx"},
    "openai": {"base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "backend": "sdk"},
    "gemini": {"base_url": "https://generativelanguage.googleapis.com", "model": "gemini-2.0-flash", "backend": "httpx"},
}
EMBED_DEFAULTS = {
    "gemini": {"base_url": "https://generativelanguage.googleapis.com", "model": "gemini-embedding-001"},
    "openai": {"base_url": "https://api.openai.com/v1", "model": "text-embedding-3-small"},
}

# Advanced settings
ROUTE_INTENTION = os.environ.get("ROUTE_INTENTION", "true").lower() == "true"
SUFFICIENCY_CHECK = os.environ.get("SUFFICIENCY_CHECK", "true").lower() == "true"
ENABLE_REINFORCEMENT = os.environ.get("ENABLE_REINFORCEMENT", "true").lower() == "true"
CATEGORY_ASSIGN_THRESHOLD = float(os.environ.get("CATEGORY_ASSIGN_THRESHOLD", "0.25"))
RANKING_STRATEGY = os.environ.get("RANKING_STRATEGY", "salience")  # "similarity" | "salience"
RECENCY_DECAY_DAYS = float(os.environ.get("RECENCY_DECAY_DAYS", "30"))

# Global service instance
_service = None

def get_service():
    global _service
    if _service is None:
        # Resolve provider settings with defaults
        llm_defaults = PROVIDER_DEFAULTS.get(LLM_PROVIDER, PROVIDER_DEFAULTS["openai"])
        embed_prov = EMBED_PROVIDER or ("gemini" if LLM_PROVIDER == "anthropic" else LLM_PROVIDER)
        embed_defaults = EMBED_DEFAULTS.get(embed_prov, EMBED_DEFAULTS["openai"])

        llm_profile = {
            "provider": LLM_PROVIDER,
            "api_key": ANTHROPIC_TOKEN,
            "chat_model": LLM_MODEL or llm_defaults["model"],
            "base_url": LLM_BASE_URL or llm_defaults["base_url"],
            "client_backend": llm_defaults["backend"],
            "embed_provider": embed_prov,
            "embed_api_key": GEMINI_API_KEY or ANTHROPIC_TOKEN,
            "embed_base_url": EMBED_BASE_URL or embed_defaults["base_url"],
            "embed_model": EMBED_MODEL or embed_defaults["model"],
        }

        _service = MemoryService(
            llm_profiles={"default": llm_profile},
            database_config={
                "metadata_store": {
                    "provider": "sqlite",
                    "dsn": f"sqlite:///{DB_PATH}",
                },
            },
            memorize_config={
                "memory_categories": [
                    {"name": "User Profile", "description": "User information and identity"},
                    {"name": "Preferences", "description": "User preferences and settings"},
                    {"name": "Facts", "description": "Important facts and knowledge"},
                    {"name": "Events", "description": "Notable events and occurrences"},
                ],
                "enable_item_reinforcement": ENABLE_REINFORCEMENT,
                "category_assign_threshold": CATEGORY_ASSIGN_THRESHOLD,
            },
            retrieve_config={
                "route_intention": ROUTE_INTENTION,
                "sufficiency_check": SUFFICIENCY_CHECK,
                "item": {
                    "ranking": RANKING_STRATEGY,
                    "recency_decay_days": RECENCY_DECAY_DAYS,
                },
            },
        )
    return _service

async def judge_and_extract(content: str) -> dict:
    """Use LLM to judge importance and extract structured memory info.
    
    Returns:
        {"skip": True} if not worth remembering
        {"skip": False, "summary": str, "type": str, "categories": list} if worth it
    """
    service = get_service()
    llm = service._get_llm_client()
    
    capture_detail = os.environ.get("CAPTURE_DETAIL", "medium")
    
    if capture_detail == "high":
        filter_guidance = """NOT worth remembering (respond SKIP):
- Pure system messages, heartbeat/health checks
- Exact duplicates of already-known information

WORTH remembering (be generous — capture details):
- User identity, preferences, opinions, habits
- Important decisions or agreements
- New facts about the user, their projects, or people they know
- Significant events or milestones
- Technical discoveries or lessons learned
- Relationship dynamics or emotional context
- Specific details: names, dates, numbers, places
- Casual mentions that reveal personality or interests
- Group chat dynamics, jokes with context, recurring topics
- Small but meaningful details (pet names, food preferences, etc.)"""
    elif capture_detail == "low":
        filter_guidance = """NOT worth remembering (respond SKIP):
- Casual greetings, small talk, jokes without substance
- System messages, tool outputs, status checks
- Temporary states ("I'm cooking", "brb")
- Heartbeat/health checks
- Repetitive or trivial exchanges
- Already-known information being restated
- Minor details or fleeting conversations

WORTH remembering:
- Critical user identity information
- Important decisions or agreements
- Major milestones or events"""
    else:  # medium (default)
        filter_guidance = """NOT worth remembering (respond SKIP):
- Casual greetings, small talk, jokes without substance
- System messages, tool outputs, status checks
- Temporary states ("I'm cooking", "brb")
- Heartbeat/health checks
- Repetitive or trivial exchanges
- Already-known information being restated

WORTH remembering:
- User identity, preferences, opinions
- Important decisions or agreements
- New facts about the user or their projects
- Significant events or milestones
- Technical discoveries or lessons learned
- Relationship dynamics or emotional context"""

    prompt = f"""You are a memory filter for an AI assistant. Analyze this conversation and decide if it contains information worth remembering long-term.

{filter_guidance}

Conversation:
{content}

If NOT worth remembering, respond with exactly: SKIP
If WORTH remembering, respond in this exact JSON format:
{{"summary": "one concise sentence capturing the key info", "type": "one of: profile/preference/fact/event", "categories": ["one or more of: User Profile, Preferences, Facts, Events"]}}"""
    
    response = await llm.chat(prompt)
    response = response.strip()
    
    if response.upper() == "SKIP" or response.upper().startswith("SKIP"):
        return {"skip": True}
    
    try:
        # Try to parse JSON (handle markdown code blocks)
        cleaned = response
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
            cleaned = cleaned.rsplit("```", 1)[0]
        data = json.loads(cleaned)
        return {
            "skip": False,
            "summary": data.get("summary", ""),
            "type": data.get("type", "fact"),
            "categories": data.get("categories", ["Facts"]),
        }
    except (json.JSONDecodeError, KeyError):
        # If LLM returned non-JSON non-SKIP, treat as summary
        if len(response) > 10:
            return {"skip": False, "summary": response, "type": "fact", "categories": ["Facts"]}
        return {"skip": True}

async def store_memory(content: str, memory_type: str = None, categories: list[str] = None, skip_judge: bool = False):
    """Store a memory item with LLM-based importance judgment and dedup.
    
    If memory_type/categories not provided, LLM auto-classifies.
    If skip_judge=True, stores directly (for manual tool calls).
    """
    service = get_service()
    
    # Step 1: Judge importance and extract info
    if not skip_judge and memory_type is None:
        judgment = await judge_and_extract(content)
        if judgment.get("skip"):
            return {"success": False, "skipped": True, "reason": "Not worth remembering"}
        summary = judgment["summary"]
        memory_type = judgment.get("type", "fact")
        categories = judgment.get("categories", ["Facts"])
    else:
        # Direct store (from manual tool call) - just summarize
        llm = service._get_llm_client()
        prompt = f"Summarize in one concise sentence:\n{content}\n\nSummary:"
        summary = (await llm.chat(prompt)).strip()
        memory_type = memory_type or "fact"
        categories = categories or ["Facts"]
    
    if len(summary) < 5:
        return {"success": False, "error": "No meaningful content to store"}
    
    # Step 2: Dedup check - search for similar existing memories
    try:
        existing = await service.retrieve(
            queries=[{"role": "user", "content": summary}],
        )
        for item in existing.get("items", [])[:3]:
            existing_summary = item.get("summary", "")
            # Simple overlap check: if >70% words match, skip
            words_new = set(summary.lower().split())
            words_old = set(existing_summary.lower().split())
            if words_new and words_old:
                overlap = len(words_new & words_old) / max(len(words_new), 1)
                if overlap > 0.7:
                    return {"success": False, "skipped": True, "reason": f"Duplicate of existing memory: {item.get('id')}"}
    except Exception:
        pass  # Dedup is best-effort
    
    # Step 3: Store
    result = await service.create_memory_item(
        memory_type=memory_type,
        memory_content=summary,
        memory_categories=categories,
    )
    
    return {
        "success": True,
        "id": result.get("memory_item", {}).get("id"),
        "summary": summary,
        "type": memory_type,
        "categories": categories,
    }

async def search_memory(query: str, limit: int = 3):
    """Search for relevant memories."""
    service = get_service()
    
    result = await service.retrieve(
        queries=[{"role": "user", "content": query}],
    )
    
    items = result.get("items", [])
    return {
        "success": True,
        "count": len(items),
        "items": [
            {
                "id": item.get("id"),
                "summary": item.get("summary"),
                "type": item.get("memory_type"),
            }
            for item in items[:limit]
        ],
    }

async def delete_memory(memory_id: str):
    """Delete a specific memory item by ID."""
    service = get_service()
    
    try:
        await service.delete_memory_item(memory_id=memory_id)
        return {"success": True, "id": memory_id}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def list_memories(limit: int = 20):
    """List all memories via CRUD list API."""
    service = get_service()
    
    result = await service.list_memory_items()
    items = result.get("items", [])
    
    # Sort by created_at descending, limit
    sorted_items = sorted(items, key=lambda x: x.get("created_at", ""), reverse=True)[:limit]
    
    return {
        "success": True,
        "count": len(sorted_items),
        "total": len(items),
        "items": [
            {
                "id": item.get("id"),
                "summary": item.get("summary"),
                "type": item.get("memory_type"),
                "created_at": str(item.get("created_at", "")),
            }
            for item in sorted_items
        ],
    }

async def memorize_resource(resource_url: str, modality: str = "text", user_id: str = None, context: str = None):
    """Memorize a resource (file, image, URL) through MemU's full pipeline.
    
    This uses MemU's complete memorize workflow:
    1. Ingest resource (download/read)
    2. Preprocess (multimodal: text extraction, image captioning, etc.)
    3. Extract memory items (LLM-based extraction by memory type)
    4. Embed and store
    
    If context is provided (e.g. "This is Elrien's pet dog Moka"), it enriches
    the memorization by combining Vision/text analysis with the given context,
    falling back to a direct store if the full pipeline yields no items.
    """
    service = get_service()
    
    user = {"user_id": user_id} if user_id else None
    
    # Try the full memU pipeline first
    result = {}
    items = []
    try:
        result = await service.memorize(
            resource_url=resource_url,
            modality=modality,
            user=user,
        )
        items = result.get("memory_items", [])
    except Exception as e:
        # Pipeline failed (e.g. embedding API doesn't support image content)
        # Fall through to context-based fallback
        pass
    
    # If no items extracted, try context/vision fallback for images
    if len(items) == 0 and (context or modality == "image"):
        # For images, run vision to get description
        description = ""
        if modality == "image":
            try:
                llm = service._get_llm_client()
                description = await llm.vision(
                    prompt="Describe this image concisely.",
                    image_path=resource_url,
                    system_prompt=None,
                )
            except Exception:
                pass
        
        content = f"Context: {context}"
        if description:
            content += f"\nImage description: {description}"
        
        store_result = await store_memory(
            content=content,
            memory_type="event",
            categories=["Facts"],
        )
        if store_result.get("success"):
            return {
                "success": True,
                "resource_id": result.get("resource", {}).get("id"),
                "items_created": 1,
                "items": [{"id": store_result.get("id"), "summary": store_result.get("summary"), "type": "event"}],
                "fallback": "context_store",
            }
    
    return {
        "success": True,
        "resource_id": result.get("resource", {}).get("id"),
        "items_created": len(items),
        "items": [
            {
                "id": item.get("id"),
                "summary": item.get("summary"),
                "type": item.get("memory_type"),
            }
            for item in items
        ],
    }

async def list_categories():
    """List all memory categories with summaries."""
    service = get_service()
    
    result = await service.list_memory_categories()
    categories = result.get("categories", [])
    
    return {
        "success": True,
        "count": len(categories),
        "categories": [
            {
                "id": cat.get("id"),
                "name": cat.get("name"),
                "description": cat.get("description"),
                "summary": cat.get("summary"),
            }
            for cat in categories
        ],
    }

async def cleanup_memories(max_age_days: int = 90, min_importance: float = 0.3):
    """Clean up old, low-importance memories.
    
    Deletes memories that are:
    - Older than max_age_days AND
    - Have low reinforcement count (not frequently referenced)
    """
    service = get_service()
    from datetime import datetime, timedelta
    import pendulum
    
    cutoff = pendulum.now("UTC") - timedelta(days=max_age_days)
    
    result = await service.list_memory_items()
    items = result.get("items", [])
    
    deleted = []
    kept = 0
    for item in items:
        created = item.get("created_at")
        if created and hasattr(created, 'timestamp') and pendulum.instance(created) < cutoff:
            # Check reinforcement count - keep highly reinforced items
            extra = item.get("extra", {})
            reinforce_count = extra.get("reinforcement_count", 1) if isinstance(extra, dict) else 1
            if reinforce_count <= 1:
                try:
                    await service.delete_memory_item(memory_id=item["id"])
                    deleted.append(item["id"])
                except Exception:
                    pass
            else:
                kept += 1
        else:
            kept += 1
    
    return {
        "success": True,
        "deleted": len(deleted),
        "kept": kept,
        "total_before": len(items),
        "deleted_ids": deleted,
    }

async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command specified"}))
        sys.exit(1)
    
    command = sys.argv[1]
    
    try:
        if command == "store":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "No content specified"}))
                sys.exit(1)
            
            data = json.loads(sys.argv[2])
            result = await store_memory(
                content=data.get("content", ""),
                memory_type=data.get("type", "profile"),
                categories=data.get("categories"),
            )
            print(json.dumps(result))
            
        elif command == "search":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "No query specified"}))
                sys.exit(1)
            
            query = sys.argv[2]
            limit = int(sys.argv[3]) if len(sys.argv) > 3 else 3
            result = await search_memory(query, limit)
            print(json.dumps(result))
            
        elif command == "delete":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "No ID specified"}))
                sys.exit(1)
            
            data = json.loads(sys.argv[2])
            result = await delete_memory(data.get("id", ""))
            print(json.dumps(result))
            
        elif command == "list":
            limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20
            result = await list_memories(limit)
            print(json.dumps(result, default=str))
            
        elif command == "memorize":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "No resource URL specified"}))
                sys.exit(1)
            data = json.loads(sys.argv[2])
            result = await memorize_resource(
                resource_url=data.get("url", ""),
                modality=data.get("modality", "text"),
                user_id=data.get("user_id"),
                context=data.get("context"),
            )
            print(json.dumps(result, default=str))
            
        elif command == "categories":
            result = await list_categories()
            print(json.dumps(result, default=str))
            
        elif command == "cleanup":
            data = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
            result = await cleanup_memories(
                max_age_days=data.get("max_age_days", 90),
                min_importance=data.get("min_importance", 0.3),
            )
            print(json.dumps(result, default=str))
            
        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))
            sys.exit(1)
            
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
