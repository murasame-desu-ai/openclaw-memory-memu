/**
 * OpenClaw Memory (memU) Plugin
 *
 * Long-term memory using memU framework.
 * Uses Anthropic Claude for LLM and Gemini for embeddings.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Call the Python memU wrapper script.
 */
async function callMemu(config, command, args) {
    return new Promise((resolve) => {
        const pythonPath = config.pythonPath || "python3";
        const wrapperPath = join(__dirname, "memu_wrapper.py");
        const env = {
            ...process.env,
            ANTHROPIC_TOKEN: config.anthropicToken,
            GEMINI_API_KEY: config.geminiApiKey,
            MEMU_PATH: config.memuPath || "/home/murasame/projects/memu/src",
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
            }
            catch {
                resolve({ error: `Failed to parse output: ${stdout}` });
            }
        });
        proc.on("error", (err) => {
            resolve({ error: err.message });
        });
    });
}
/**
 * Detect memory category from text content.
 */
function detectCategory(text) {
    const lower = text.toLowerCase();
    if (lower.includes("이름") || lower.includes("name") || lower.includes("나는")) {
        return ["User Profile"];
    }
    if (lower.includes("좋아") || lower.includes("선호") || lower.includes("prefer")) {
        return ["Preferences"];
    }
    if (lower.includes("했") || lower.includes("갔") || lower.includes("만났")) {
        return ["Events"];
    }
    return ["Facts"];
}
/**
 * Check if text is worth capturing as memory.
 * Minimal filtering - let memU's LLM decide what's important.
 */
function shouldCapture(text) {
    // Skip very short text (10자 이상)
    if (text.length < 10)
        return false;
    // Skip tool calls and code blocks
    if (text.startsWith("{") || text.startsWith("```"))
        return false;
    // Let memU's LLM decide what's worth remembering
    return true;
}
/**
 * Remove injected memory tags from content before storing.
 */
function stripMemoryTags(text) {
    return text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "").trim();
}
const memuPlugin = {
    register(api) {
        // Debug: confirm register is called
        appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] register() called\n`);
        const cfg = (api.pluginConfig ?? {});
        // Validate config
        if (!cfg.anthropicToken || !cfg.geminiApiKey) {
            api.logger.error("memory-memu: Missing required config (anthropicToken, geminiApiKey)");
            return;
        }
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
                    const result = await callMemu(cfg, "search", [event.prompt, "3"]);
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
                }
                catch (err) {
                    api.logger.warn?.(`memory-memu: recall failed: ${String(err)}`);
                }
            });
        }
        // Auto-capture: store important info after agent ends
        appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] autoCapture check: cfg.autoCapture=${cfg.autoCapture}\n`);
        if (cfg.autoCapture !== false) {
            appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] registering agent_end hook\n`);
            api.on("agent_end", async (event) => {
                // Debug: log event structure
                appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] agent_end: ${JSON.stringify({
                    success: event.success,
                    messagesLength: event.messages?.length,
                    firstMsg: event.messages?.[0],
                }, null, 2)}\n`);
                api.logger.info?.(`memory-memu: agent_end triggered, success=${event.success}, messages=${event.messages?.length ?? 0}`);
                if (!event.success || !event.messages || event.messages.length === 0) {
                    api.logger.info?.(`memory-memu: skipping capture - no valid messages`);
                    return;
                }
                try {
                    const messages = [];
                    for (const msg of event.messages) {
                        if (!msg || typeof msg !== "object")
                            continue;
                        const msgObj = msg;
                        const role = msgObj.role;
                        if (role !== "user" && role !== "assistant")
                            continue;
                        let content = "";
                        if (typeof msgObj.content === "string") {
                            content = msgObj.content;
                        }
                        else if (Array.isArray(msgObj.content)) {
                            for (const block of msgObj.content) {
                                if (block &&
                                    typeof block === "object" &&
                                    block.type === "text" &&
                                    typeof block.text === "string") {
                                    content += block.text;
                                }
                            }
                        }
                        if (content.trim()) {
                            messages.push({ role, content: content.trim() });
                        }
                    }
                    appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] extracted messages: ${messages.length}\n`);
                    if (messages.length < 2) {
                        appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] skipping - not enough messages\n`);
                        return; // Need at least user + assistant
                    }
                    // Get current turn (last user + last assistant)
                    let lastAssistantIdx = -1;
                    for (let i = messages.length - 1; i >= 0; i--) {
                        if (messages[i].role === "assistant") {
                            lastAssistantIdx = i;
                            break;
                        }
                    }
                    if (lastAssistantIdx < 0)
                        return;
                    // Find the user message before the last assistant
                    let lastUserIdx = -1;
                    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
                        if (messages[i].role === "user") {
                            lastUserIdx = i;
                            break;
                        }
                    }
                    if (lastUserIdx < 0)
                        return;
                    const currentTurn = [messages[lastUserIdx], messages[lastAssistantIdx]];
                    // Get context (2 messages before current turn)
                    const contextMessages = messages.slice(Math.max(0, lastUserIdx - 2), lastUserIdx);
                    // Build content with context
                    let content = "";
                    if (contextMessages.length > 0) {
                        const contextStr = contextMessages
                            .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 100)}...`)
                            .join("\n");
                        content += `(이전 맥락:\n${contextStr})\n\n`;
                    }
                    content += currentTurn
                        .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
                        .join("\n");
                    // Remove injected memory tags
                    content = stripMemoryTags(content);
                    // Skip if not worth capturing
                    if (!shouldCapture(content)) {
                        appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] skipping - shouldCapture returned false\n`);
                        return;
                    }
                    appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] calling memU store...\n`);
                    // Send to memU
                    const result = await callMemu(cfg, "store", [
                        JSON.stringify({
                            content,
                            type: "event",
                            categories: ["Facts"],
                        }),
                    ]);
                    appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] store result: ${JSON.stringify(result)}\n`);
                    if (result.success) {
                        api.logger.info?.(`memory-memu: captured conversation memory`);
                    }
                }
                catch (err) {
                    appendFileSync("/tmp/memu-debug.log", `\n[${new Date().toISOString()}] capture error: ${String(err)}\n`);
                    api.logger.warn?.(`memory-memu: capture failed: ${String(err)}`);
                }
            });
        }
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
//# sourceMappingURL=index.js.map