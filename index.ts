/**
 * OpenClaw Memory (memU) Plugin
 *
 * Long-term memory using memU framework.
 * Uses Anthropic Claude for LLM and Gemini for embeddings.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Periodic cleanup state
let lastCleanupTime = 0;

/**
 * Resolve the currently active Anthropic token from OpenClaw's auth profiles.
 * Falls back to the static config token if auth-profiles.json is unavailable.
 */
function resolveAnthropicToken(staticToken: string): string {
  try {
    const authPath = join(homedir(), ".openclaw/agents/main/agent/auth-profiles.json");
    const data = JSON.parse(readFileSync(authPath, "utf8"));
    const lastGood = data.lastGood?.anthropic;
    if (lastGood && data.profiles?.[lastGood]?.token) {
      return data.profiles[lastGood].token;
    }
    // If no lastGood, try any anthropic profile
    for (const [id, profile] of Object.entries(data.profiles ?? {})) {
      if (id.startsWith("anthropic:") && (profile as any)?.token) {
        return (profile as any).token;
      }
    }
  } catch {
    // Fall back to static token
  }
  return staticToken;
}

interface MemuConfig {
  anthropicToken: string;
  geminiApiKey?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  pythonPath?: string;
  memuPath?: string;
  // LLM provider settings
  llmProvider?: string;       // "anthropic" | "openai" | "gemini" (default: "anthropic")
  llmBaseUrl?: string;        // API base URL
  llmModel?: string;          // Chat model name
  // Embedding provider settings
  embedProvider?: string;     // "gemini" | "openai" (default: "gemini")
  embedBaseUrl?: string;      // Embedding API base URL
  embedModel?: string;        // Embedding model name
  // Retrieve settings
  routeIntention?: boolean;           // Judge if retrieval needed & rewrite query (default: true)
  sufficiencyCheck?: boolean;         // Check if results are sufficient (default: true)
  // Memorize settings
  enableReinforcement?: boolean;      // Track repeated info with higher weight (default: true)
  categoryAssignThreshold?: number;   // Auto-categorization threshold 0-1 (default: 0.25)
  // Memory maintenance
  cleanupMaxAgeDays?: number;         // Auto-cleanup: max age in days (default: 90)
  cleanupIntervalHours?: number;      // Auto-cleanup interval in hours (default: 0 = disabled)
  // Capture settings  
  captureDetail?: string;             // "low" | "medium" | "high" (default: "medium") — how detailed to capture
  // Recall settings
  recallTopK?: number;                // Number of memories to retrieve (default: 3)
  // Salience ranking
  rankingStrategy?: string;           // "similarity" | "salience" (default: "salience")
  recencyDecayDays?: number;          // Half-life for recency decay (default: 30)
}

interface MemuResult {
  success?: boolean;
  error?: string;
  id?: string;
  count?: number;
  items?: Array<{
    id: string;
    summary: string;
    type: string;
  }>;
}

/**
 * Call the Python memU wrapper script.
 */
async function callMemu(
  config: MemuConfig,
  command: string,
  args: string[],
): Promise<MemuResult> {
  return new Promise((resolve) => {
    const pythonPath = config.pythonPath || "python3";
    const wrapperPath = join(__dirname, "memu_wrapper.py");

    const env = {
      ...process.env,
      ANTHROPIC_TOKEN: resolveAnthropicToken(config.anthropicToken),
      GEMINI_API_KEY: config.geminiApiKey || "",
      MEMU_PATH: config.memuPath || "",
      LLM_PROVIDER: config.llmProvider || "anthropic",
      LLM_BASE_URL: config.llmBaseUrl || "",
      LLM_MODEL: config.llmModel || "",
      EMBED_PROVIDER: config.embedProvider || "",
      EMBED_BASE_URL: config.embedBaseUrl || "",
      EMBED_MODEL: config.embedModel || "",
      ROUTE_INTENTION: String(config.routeIntention ?? true),
      SUFFICIENCY_CHECK: String(config.sufficiencyCheck ?? true),
      ENABLE_REINFORCEMENT: String(config.enableReinforcement ?? true),
      CATEGORY_ASSIGN_THRESHOLD: String(config.categoryAssignThreshold ?? 0.25),
      CLEANUP_MAX_AGE_DAYS: String(config.cleanupMaxAgeDays ?? 90),
      CLEANUP_INTERVAL_HOURS: String(config.cleanupIntervalHours ?? 0),
      RANKING_STRATEGY: config.rankingStrategy || "salience",
      RECENCY_DECAY_DAYS: String(config.recencyDecayDays ?? 30),
      CAPTURE_DETAIL: config.captureDetail || "medium",
    };

    const proc = spawn(pythonPath, [wrapperPath, command, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ error: stderr || `Process exited with code ${code}` });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        resolve({ error: `Failed to parse output: ${stdout}` });
      }
    });

    proc.on("error", (err) => {
      resolve({ error: err.message });
    });
  });
}

/**
 * Pre-filter before sending to LLM judgment.
 * Cheap checks to avoid unnecessary LLM calls.
 */
function shouldCapture(text: string): boolean {
  if (text.length < 20) return false;

  // Skip pure tool/code output
  if (text.startsWith("{") || text.startsWith("```")) return false;

  // Strip memory tags before content checks
  const stripped = stripMemoryTags(text);

  // Skip if too short after stripping tags
  if (stripped.length < 50) return false;

  // Skip empty content
  if (/^\s*$/.test(stripped)) return false;

  // Noise pattern filters — skip known non-memorable content
  const noisePatterns = [
    /I don't have access to/i,
    /I cannot (summarize|process|access|read)/i,
    /NO_REPLY/,
    /HEARTBEAT_OK/,
    /\[MISSING\]/,
    /GatewayRestart/,
    /Error:|error:|ENOENT|ETIMEDOUT|ECONNREFUSED/,
    /I cannot fulfill|I'm unable to|I don't have the ability/i,
    /\[compacted:|truncated:/i,
  ];
  for (const pattern of noisePatterns) {
    if (pattern.test(stripped)) return false;
  }

  // Skip empty role lines (entire content is just empty role prefixes)
  const withoutEmptyRoles = stripped.replace(/^(User|Assistant):\s*$/gm, "").trim();
  if (withoutEmptyRoles.length < 50) return false;

  // Skip heartbeat-only exchanges
  if (/^(User:.*HEARTBEAT.*\n?Assistant:.*HEARTBEAT_OK)/is.test(stripped)) return false;

  return true;
}

/**
 * Remove injected memory tags from content before storing.
 */
function stripMemoryTags(text: string): string {
  return text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "").trim();
}

/**
 * Strip OpenClaw metadata from user messages, keeping only actual content.
 * Extracts sender name from metadata before removing it.
 */
function stripMessageMetadata(text: string): { content: string; sender: string | null } {
  let sender: string | null = null;
  
  // Extract sender name before stripping
  const senderMatch = text.match(/"sender":\s*"([^"]+)"/);
  if (senderMatch) sender = senderMatch[1];
  
  let result = text;
  // Strip relevant-memories
  result = result.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "");
  // Strip Conversation info block
  result = result.replace(/Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "");
  // Strip Sender block
  result = result.replace(/Sender \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "");
  
  return { content: result.trim(), sender };
}

const memuPlugin = {
  register(api: OpenClawPluginApi) {
    
    const cfg = (api.pluginConfig ?? {}) as unknown as MemuConfig;

    // Validate config
    if (!cfg.anthropicToken || !cfg.geminiApiKey) {
      api.logger.error("memory-memu: Missing required config (anthropicToken, geminiApiKey)");
      return;
    }

    // ========================================================================
    // Clean message buffer — session-scoped, metadata-free
    // ========================================================================
    
    interface CleanMessage {
      role: "user" | "assistant";
      sender: string;
      content: string;
      timestamp: number;
    }
    
    // Session-scoped buffers (#2: sessionKey-based separation)
    const sessionBuffers = new Map<string, CleanMessage[]>();
    const MAX_BUFFER_SIZE = 20;
    let currentSessionKey: string | null = null;
    let currentSessionId: string | null = null;
    
    function getBuffer(key?: string): CleanMessage[] {
      const k = key || currentSessionKey || "__default__";
      if (!sessionBuffers.has(k)) sessionBuffers.set(k, []);
      return sessionBuffers.get(k)!;
    }
    
    function pushToBuffer(key: string | undefined, msg: CleanMessage) {
      const buf = getBuffer(key);
      buf.push(msg);
      if (buf.length > MAX_BUFFER_SIZE) buf.shift();
    }

    // #4: Reset buffer on session reset (sessionId change)
    api.on("session_start", async (event, ctx) => {
      const newSessionKey = ctx.sessionKey || event.sessionKey;
      const newSessionId = event.sessionId;
      
      if (newSessionKey) {
        // If sessionId changed for same sessionKey → session was reset
        if (currentSessionKey === newSessionKey && currentSessionId && currentSessionId !== newSessionId) {
          sessionBuffers.delete(newSessionKey);
          api.logger.info?.(`memory-memu: buffer reset for session ${newSessionKey} (session reset detected)`);
        }
        currentSessionKey = newSessionKey;
      }
      if (newSessionId) currentSessionId = newSessionId;
    });
    
    // Clean up ended session buffers
    api.on("session_end", async (event, ctx) => {
      const key = ctx.sessionKey || event.sessionKey;
      if (key && key !== currentSessionKey) {
        sessionBuffers.delete(key);
      }
    });

    // #1: Capture clean user messages at message_received
    api.on("message_received", async (event) => {
      const senderName = (event.metadata?.senderName as string) || "User";
      if (event.content?.trim()) {
        pushToBuffer(currentSessionKey ?? undefined, {
          role: "user",
          sender: senderName,
          content: event.content.trim(),
          timestamp: Date.now(),
        });
      }
    });

    // #1: Use message_sent instead of message_sending (only capture successful sends)
    api.on("message_sent", async (event) => {
      if (event.success && event.content?.trim()) {
        pushToBuffer(currentSessionKey ?? undefined, {
          role: "assistant",
          sender: "Assistant",
          content: event.content.trim(),
          timestamp: Date.now(),
        });
      }
    });
    
    // #3: Also capture via before_message_write for assistant responses
    // that don't go through message_sent (e.g. inline replies)
    api.on("before_message_write", (event, ctx) => {
      const msg = event.message as unknown as Record<string, unknown>;
      if (msg?.role === "assistant") {
        let text = "";
        if (typeof msg.content === "string") text = msg.content;
        else if (Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block?.type === "text" && typeof block.text === "string") text += block.text;
          }
        }
        if (text.trim() && !text.includes("NO_REPLY")) {
          pushToBuffer(ctx.sessionKey ?? undefined, {
            role: "assistant",
            sender: "Assistant",
            content: text.trim(),
            timestamp: Date.now(),
          });
        }
      }
    });

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: search memories before agent starts
    if (cfg.autoRecall !== false) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 10) {
          return;
        }

        try {
          const result = await callMemu(cfg, "search", [event.prompt, String(cfg.recallTopK ?? 3)]);

          if (result.error || !result.items || result.items.length === 0) {
            return;
          }

          const memoryContext = result.items
            .map((item) => `- [${item.type}] ${item.summary}`)
            .join("\n");

          api.logger.info?.(`memory-memu: injecting ${result.items.length} memories`);

          return {
            prependContext: `<relevant-memories>\n관련 기억:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn?.(`memory-memu: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: store important info after agent ends
    if (cfg.autoCapture !== false) {
      api.on("agent_end", async (event, ctx) => {
        // #5: Skip heartbeat/cron/memory triggers — they produce noise, not memories
        const trigger = (ctx as any)?.trigger as string | undefined;
        if (trigger === "heartbeat" || trigger === "cron" || trigger === "memory") {
          api.logger.info?.(`memory-memu: skipping capture for trigger=${trigger}`);
          return;
        }

        api.logger.info?.(`memory-memu: agent_end triggered, success=${event.success}, trigger=${trigger || "user"}, messages=${event.messages?.length ?? 0}`);
        
        if (!event.success || !event.messages || event.messages.length === 0) {
          api.logger.info?.(`memory-memu: skipping capture - no valid messages`);
          return;
        }

        try {
          // Use clean message buffer (captured at message_received/message_sending)
          // This avoids metadata pollution from OpenClaw's message formatting
          
          const cleanMessageBuffer = getBuffer(ctx.sessionKey);
          if (cleanMessageBuffer.length < 2) {
            // Fallback: extract from agent_end messages if buffer is empty (e.g. first turn after restart)
            const lastMsg = event.messages?.[event.messages.length - 1] as Record<string, unknown> | undefined;
            if (!lastMsg || lastMsg.role !== "assistant") return;
            let assistantContent = "";
            if (typeof lastMsg.content === "string") {
              assistantContent = lastMsg.content;
            } else if (Array.isArray(lastMsg.content)) {
              for (const block of lastMsg.content) {
                if (block && typeof block === "object" && (block as any).type === "text") {
                  assistantContent += (block as any).text ?? "";
                }
              }
            }
            if (!assistantContent.trim()) return;
            
            // Find last user message
            let userContent = "";
            for (let i = event.messages.length - 2; i >= 0; i--) {
              const m = event.messages[i] as Record<string, unknown>;
              if (m.role === "user") {
                if (typeof m.content === "string") userContent = m.content;
                else if (Array.isArray(m.content)) {
                  for (const block of m.content) {
                    if (block && typeof block === "object" && (block as any).type === "text") {
                      userContent += (block as any).text ?? "";
                    }
                  }
                }
                break;
              }
            }
            if (!userContent.trim()) return;
            
            // Strip metadata as fallback
            const { content: cleanUser, sender } = stripMessageMetadata(userContent);
            const content = `${sender || "User"}: ${cleanUser}\nAssistant: ${assistantContent.trim()}`;
            if (!shouldCapture(content)) return;
            
            const result = await callMemu(cfg, "store", [JSON.stringify({ content })]);
            if ((result as any).skipped) {
              api.logger.info?.(`memory-memu: skipped - ${(result as any).reason}`);
            } else if (result.success) {
              api.logger.info?.(`memory-memu: captured [${(result as any).type}] ${(result as any).summary?.slice(0, 60)}`);
            }
            return;
          }

          // Find current turn from clean buffer (last user + last assistant)
          let lastAssistant: CleanMessage | null = null;
          let lastUser: CleanMessage | null = null;
          
          for (let i = cleanMessageBuffer.length - 1; i >= 0; i--) {
            if (!lastAssistant && cleanMessageBuffer[i].role === "assistant") {
              lastAssistant = cleanMessageBuffer[i];
            }
            if (lastAssistant && cleanMessageBuffer[i].role === "user") {
              lastUser = cleanMessageBuffer[i];
              break;
            }
          }
          
          if (!lastUser || !lastAssistant) return;

          // Build context from earlier messages in buffer
          const currentUserIdx = cleanMessageBuffer.indexOf(lastUser);
          const contextMsgs = cleanMessageBuffer.slice(Math.max(0, currentUserIdx - 4), currentUserIdx);
          
          let content = "";
          if (contextMsgs.length > 0) {
            const contextStr = contextMsgs
              .map(m => `${m.sender}: ${m.content}`)
              .join("\n");
            content += `(이전 맥락:\n${contextStr})\n\n`;
          }
          
          content += `${lastUser.sender}: ${lastUser.content}\nAssistant: ${lastAssistant.content}`;

          // Skip if not worth capturing
          if (!shouldCapture(content)) {
            return;
          }

          
          // Send to memU (LLM judges importance and classifies automatically)
          const result = await callMemu(cfg, "store", [
            JSON.stringify({
              content,
            }),
          ]);

          if ((result as any).skipped) {
            api.logger.info?.(`memory-memu: skipped - ${(result as any).reason}`);
          } else if (result.success) {
            api.logger.info?.(`memory-memu: captured [${(result as any).type}] ${(result as any).summary?.slice(0, 60)}`);
          }
        } catch (err) {
          api.logger.warn?.(`memory-memu: capture failed: ${String(err)}`);
        }

        // Periodic cleanup: remove old unreinforced memories
        const cleanupIntervalMs = (cfg.cleanupIntervalHours ?? 0) * 60 * 60 * 1000;
        try {
          const now = Date.now();
          if (cleanupIntervalMs > 0 && now - lastCleanupTime > cleanupIntervalMs) {
            const maxAge = cfg.cleanupMaxAgeDays ?? 90;
            api.logger.info?.(`memory-memu: running periodic cleanup (maxAge=${maxAge}d)`);
            const cleanupResult = await callMemu(cfg, "cleanup", [JSON.stringify({ max_age_days: maxAge })]);
            lastCleanupTime = now;
          }
        } catch (err) {
          api.logger.warn?.(`memory-memu: periodic cleanup failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Agent Tools
    // ========================================================================

    // memory_delete — delete a memory by ID
    api.registerTool({
      name: "memory_delete",
      label: "Delete Memory",
      description: "Delete a specific memory item by its UUID. Use when the user asks to forget something or remove a memory.",
      parameters: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "UUID of the memory item to delete" },
        },
        required: ["id"],
      },
      async execute(_id: string, params: { id: string }) {
        const result = await callMemu(cfg, "delete", [JSON.stringify({ id: params.id })]);
        return jsonResult(result);
      },
    });

    // memory_list — list recent memories
    api.registerTool({
      name: "memory_list",
      label: "List Memories",
      description: "List recent memory items. Returns summaries sorted by creation date (newest first).",
      parameters: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Maximum number of items to return (default: 20)" },
        },
      },
      async execute(_id: string, params: { limit?: number }) {
        const limit = String(params.limit ?? 20);
        const result = await callMemu(cfg, "list", [limit]);
        return jsonResult(result);
      },
    });

    // memory_memorize — ingest a resource (file/URL) into memory
    api.registerTool({
      name: "memory_memorize",
      label: "Memorize Resource",
      description: "Memorize a resource (file or URL) through the full MemU pipeline: ingest → extract → embed → store. Supports text files, images, and web pages. Use 'context' to provide additional info (e.g. who/what is in the image).",
      parameters: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "Resource URL (file:///path or https://...)" },
          modality: { type: "string", description: "Resource type: text, image, or auto (default: text)" },
          context: { type: "string", description: "Additional context about the resource (e.g. 'Elrien's pet dog Moka')" },
        },
        required: ["url"],
      },
      async execute(_id: string, params: { url: string; modality?: string; context?: string }) {
        const result = await callMemu(cfg, "memorize", [JSON.stringify({
          url: params.url,
          modality: params.modality ?? "text",
          context: params.context,
        })]);
        return jsonResult(result);
      },
    });

    // memory_categories — list all memory categories
    api.registerTool({
      name: "memory_categories",
      label: "Memory Categories",
      description: "List all memory categories with their descriptions and summaries.",
      parameters: {
        type: "object" as const,
        properties: {},
      },
      async execute() {
        const result = await callMemu(cfg, "categories", []);
        return jsonResult(result);
      },
    });

    // memory_cleanup — delete old unreinforced memories
    api.registerTool({
      name: "memory_cleanup",
      label: "Memory Cleanup",
      description: "Clean up old, low-importance memories. Deletes unreinforced memories older than the specified number of days.",
      parameters: {
        type: "object" as const,
        properties: {
          max_age_days: { type: "number", description: "Delete unreinforced memories older than this many days (default: 90)" },
        },
      },
      async execute(_id: string, params: { max_age_days?: number }) {
        const result = await callMemu(cfg, "cleanup", [JSON.stringify({
          max_age_days: params.max_age_days ?? 90,
        })]);
        return jsonResult(result);
      },
    });

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-memu",
      start: () => {
        api.logger.info("memory-memu: initialized (Anthropic LLM + Gemini embeddings)");
      },
      stop: () => {
        api.logger.info("memory-memu: stopped");
      },
    });
  },
};

export default memuPlugin;
