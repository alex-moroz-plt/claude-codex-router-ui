import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_CLAUDE_ROOT = path.join(homedir(), ".claude", "projects");
const DEFAULT_CODEX_ROOT = path.join(homedir(), ".codex", "sessions");

function number(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function timestampValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectName(cwd, fallback = "Local task") {
  if (typeof cwd !== "string" || !cwd.trim()) return fallback;
  const normalized = path.normalize(cwd);
  return path.basename(normalized) || normalized;
}

function cleanTitle(value) {
  if (typeof value !== "string") return "";
  let text = value;
  for (const marker of ["My request for Codex:", "My request:"]) {
    const index = text.lastIndexOf(marker);
    if (index !== -1) text = text.slice(index + marker.length);
  }
  return text
    .replace(/<response-annotations>[\s\S]*?<\/response-annotations>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

function shortId(value) {
  const id = String(value || "unknown");
  return id.length > 8 ? id.slice(-8) : id;
}

function modelLabel(models) {
  const values = [...models].filter(Boolean);
  if (!values.length) return "Unknown model";
  if (values.length <= 2) return values.join(" + ");
  return `${values.slice(0, 2).join(" + ")} +${values.length - 2}`;
}

export function summarizeClaudeRecords(records, filePath = "claude-session.jsonl") {
  const usage = { input: 0, cached: 0, output: 0, total: 0 };
  const models = new Set();
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = "";
  let title = "";
  let titlePriority = 0;
  let firstAt = 0;
  let updatedAt = 0;
  let hasUsage = false;

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (record.sessionId) sessionId = record.sessionId;
    if (record.cwd) cwd = record.cwd;
    const candidateTitle = record.type === "custom-title" ? record.customTitle
      : record.type === "ai-title" ? record.aiTitle
        : record.type === "last-prompt" ? record.lastPrompt
          : "";
    const priority = record.type === "custom-title" ? 3 : record.type === "ai-title" ? 2 : record.type === "last-prompt" ? 1 : 0;
    if (priority >= titlePriority) {
      const cleaned = cleanTitle(candidateTitle);
      if (cleaned) {
        title = cleaned;
        titlePriority = priority;
      }
    }
    const at = timestampValue(record.timestamp);
    if (at) {
      firstAt = firstAt ? Math.min(firstAt, at) : at;
      updatedAt = Math.max(updatedAt, at);
    }

    const messageUsage = record.message?.usage;
    if (!messageUsage || typeof messageUsage !== "object") continue;
    hasUsage = true;
    if (record.message?.model) models.add(record.message.model);
    const input = number(messageUsage.input_tokens);
    const cached = number(messageUsage.cache_creation_input_tokens) + number(messageUsage.cache_read_input_tokens);
    const output = number(messageUsage.output_tokens);
    usage.input += input;
    usage.cached += cached;
    usage.output += output;
    usage.total += input + cached + output;
  }

  if (!hasUsage) return null;
  const project = projectName(cwd, "Claude task");
  return {
    id: `claude:${sessionId}`,
    sessionId: shortId(sessionId),
    provider: "claude",
    task: title || project,
    project,
    cwd,
    model: modelLabel(models),
    effort: "Selected in Claude",
    startedAt: firstAt ? new Date(firstAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    usage,
    cacheIsSubset: false,
    source: "~/.claude/projects"
  };
}

export function summarizeCodexRecords(records, filePath = "codex-session.jsonl") {
  const models = new Set();
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = "";
  let effort = "";
  let title = "";
  let firstAt = 0;
  let updatedAt = 0;
  let latestUsage = null;

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const at = timestampValue(record.timestamp);
    if (at) {
      firstAt = firstAt ? Math.min(firstAt, at) : at;
      updatedAt = Math.max(updatedAt, at);
    }
    if (record.type === "session_meta") {
      if (record.payload?.id) sessionId = record.payload.id;
      if (record.payload?.cwd) cwd = record.payload.cwd;
    }
    if (record.type === "turn_context") {
      if (record.payload?.cwd) cwd = record.payload.cwd;
      if (record.payload?.model) models.add(record.payload.model);
      if (record.payload?.effort) effort = record.payload.effort;
      else if (record.payload?.reasoning_effort) effort = record.payload.reasoning_effort;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const cleaned = cleanTitle(record.payload.message);
      if (cleaned) title = cleaned;
    }
    if (record.type === "event_msg" && record.payload?.type === "token_count") {
      const total = record.payload?.info?.total_token_usage;
      if (total && typeof total === "object") latestUsage = total;
    }
  }

  if (!latestUsage) return null;
  const input = number(latestUsage.input_tokens);
  const cached = number(latestUsage.cached_input_tokens);
  const output = number(latestUsage.output_tokens);
  const total = number(latestUsage.total_tokens) || input + output;
  const project = projectName(cwd, "Codex task");
  return {
    id: `codex:${sessionId}`,
    sessionId: shortId(sessionId),
    provider: "codex",
    task: title || project,
    project,
    cwd,
    model: modelLabel(models),
    effort: effort || "Unknown effort",
    startedAt: firstAt ? new Date(firstAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    usage: { input, cached, output, total },
    cacheIsSubset: true,
    source: "~/.codex/sessions"
  };
}

async function collectJsonlFiles(root, exclude = () => false) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES") continue;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (exclude(fullPath)) continue;
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }
  return files;
}

async function recentFiles(root, limit, exclude) {
  const paths = await collectJsonlFiles(root, exclude);
  const withTimes = await Promise.all(paths.map(async (filePath) => {
    try {
      const info = await stat(filePath);
      return { filePath, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }));
  return withTimes.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((entry) => entry.filePath);
}

async function parseJsonl(filePath, summarizer) {
  const records = [];
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially written final JSONL line should not hide the rest of the session.
    }
  }
  return summarizer(records, filePath);
}

async function parseInBatches(files, summarizer, concurrency = 4) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const index = cursor++;
      try {
        const result = await parseJsonl(files[index], summarizer);
        if (result) results.push(result);
      } catch {
        // History is best-effort and read-only; a locked or rotated log is skipped.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
  return results;
}

export async function getUsageHistory({
  limit = 20,
  claudeRoot = process.env.CLAUDE_PROJECTS_DIR || DEFAULT_CLAUDE_ROOT,
  codexRoot = process.env.CODEX_SESSIONS_DIR || DEFAULT_CODEX_ROOT
} = {}) {
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const candidateCount = Math.max(boundedLimit, 20);
  const [claudeFiles, codexFiles] = await Promise.all([
    recentFiles(claudeRoot, candidateCount, (filePath) => filePath.split(path.sep).includes("subagents")),
    recentFiles(codexRoot, candidateCount, () => false)
  ]);
  const [claude, codex] = await Promise.all([
    parseInBatches(claudeFiles, summarizeClaudeRecords),
    parseInBatches(codexFiles, summarizeCodexRecords)
  ]);
  const items = [...claude, ...codex]
    .sort((a, b) => timestampValue(b.updatedAt) - timestampValue(a.updatedAt))
    .slice(0, boundedLimit);

  const totals = {
    claude: { sessions: 0, tokens: 0 },
    codex: { sessions: 0, tokens: 0 }
  };
  for (const item of items) {
    totals[item.provider].sessions += 1;
    totals[item.provider].tokens += item.usage.total;
  }

  return {
    generatedAt: new Date().toISOString(),
    items,
    totals,
    note: "Local client counters, not billing or subscription quota units. Claude cache tokens are added to total processed tokens; Codex cached input is already included in input and total."
  };
}
