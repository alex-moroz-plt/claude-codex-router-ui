import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getUsageHistory } from "./usage-history.mjs";
import {
  findDelegatedTaskControl,
  getTelemetryStatus,
  installTelemetry,
  readDelegatedTasks,
  readRoutingTelemetry,
  uninstallTelemetry
} from "./telemetry-manager.mjs";
import {
  ensureClaudeToolPath,
  getSetupStatus,
  installBridgePlugin,
  launchSetupTerminalAction,
  runCommand,
  runBridgeSelfCheck
} from "./setup-manager.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DEFAULT_ROUTING_PATH = path.join(homedir(), ".claude", "rules", "agent-routing.md");
const ROUTING_PATH = process.env.CLAUDE_ROUTING_FILE || DEFAULT_ROUTING_PATH;
const BACKUP_DIR = process.env.CLAUDE_ROUTING_BACKUP_DIR || path.join(path.dirname(ROUTING_PATH), ".routing-ui-backups");
const HOST = "127.0.0.1";
const REQUEST_LIMIT = 64 * 1024;
const META_START = "<!-- ROUTING_UI_CONFIG\n";
const META_END = "\nROUTING_UI_CONFIG -->";

function companionEnvironment(task) {
  const env = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) {
    delete env[key];
  }
  if (task.pluginDataDir) env.CLAUDE_PLUGIN_DATA = task.pluginDataDir;
  else delete env.CLAUDE_PLUGIN_DATA;
  if (task.sessionId) env.CODEX_COMPANION_SESSION_ID = task.sessionId;
  return env;
}

function launchDetached(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid ?? null });
    });
  });
}

export async function cancelDelegatedTask(id, {
  findTask = findDelegatedTaskControl,
  getStatus = getSetupStatus,
  run = runCommand,
  nodePath = process.execPath
} = {}) {
  const task = await findTask(id);
  if (!task) throw new Error("Active delegated task was not found");
  const status = await getStatus();
  const companionPath = status.plugin?.companionPath;
  if (!companionPath || !status.plugin?.companionAvailable) {
    throw new Error("Codex companion is unavailable; repair the bridge first");
  }
  const env = companionEnvironment(task);
  const result = await run(nodePath, [companionPath, "cancel", task.id, "--json", "--cwd", task.workspaceRoot], {
    cwd: task.workspaceRoot,
    env,
    timeout: 30_000
  });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Could not cancel delegated task");
  let payload = null;
  try { payload = JSON.parse(result.stdout); } catch { /* The companion may emit a plain-text success report. */ }
  return {
    taskId: task.id,
    status: payload?.status || "cancelled"
  };
}

export async function retryDelegatedTask(id, {
  findTask = findDelegatedTaskControl,
  getStatus = getSetupStatus,
  run = runCommand,
  launch = launchDetached,
  nodePath = process.execPath
} = {}) {
  const task = await findTask(id);
  if (!task) throw new Error("Active delegated task was not found");
  if (!task.stalled) throw new Error("Only a stale delegated task can be retried");
  if (!task.canRetry) throw new Error("The original task request is unavailable and cannot be retried safely");
  const status = await getStatus();
  const companionPath = status.plugin?.companionPath;
  if (!companionPath || !status.plugin?.companionAvailable) {
    throw new Error("Codex companion is unavailable; repair the bridge first");
  }
  const env = companionEnvironment(task);
  const cancelled = await run(nodePath, [companionPath, "cancel", task.id, "--json", "--cwd", task.workspaceRoot], {
    cwd: task.workspaceRoot,
    env,
    timeout: 30_000
  });
  if (cancelled.code !== 0) throw new Error(cancelled.stderr || cancelled.stdout || "Could not prepare stale task for retry");
  if (task.retryMode === "resume") {
    const args = [companionPath, "task", "--background", "--resume", "--json", "--cwd", task.workspaceRoot];
    if (task.model) args.push("--model", task.model);
    if (task.effort) args.push("--effort", task.effort);
    if (task.write) args.push("--write");
    const resumed = await run(nodePath, args, { cwd: task.workspaceRoot, env, timeout: 30_000 });
    if (resumed.code !== 0) throw new Error(resumed.stderr || resumed.stdout || "Could not resume stale task");
    let payload = null;
    try { payload = JSON.parse(resumed.stdout); } catch { /* The companion may emit a plain-text launch report. */ }
    return {
      taskId: payload?.jobId || task.id,
      sourceTaskId: task.id,
      status: payload?.status || "queued",
      retryMode: "resume"
    };
  }
  const worker = await launch(nodePath, [companionPath, "task-worker", "--cwd", task.workspaceRoot, "--job-id", task.id], {
    cwd: task.workspaceRoot,
    env
  });
  return {
    taskId: task.id,
    status: "retrying",
    pid: worker?.pid ?? null,
    retryMode: "replay"
  };
}

export const DEFAULT_CONFIG = Object.freeze({
  version: 2,
  costProfile: "balanced",
  claudeModel: "opusplan",
  fileThreshold: 4,
  implementationFileThreshold: 3,
  planAuditEnabled: true,
  auditScope: true,
  auditHighRisk: true,
  auditUnverified: true,
  auditAmbiguity: true,
  auditExplicit: true,
  packetTokens: 600,
  responseTokens: 400,
  normalAuditEffort: "medium",
  highRiskAuditEffort: "high",
  normalAuditModel: "gpt-5.6-terra",
  highRiskAuditModel: "gpt-5.6-sol",
  normalAudits: 1,
  allowReaudit: true,
  skipNearLimit: true,
  smallModel: "gpt-5.6-luna",
  normalModel: "gpt-5.6-terra",
  riskModel: "gpt-5.6-sol",
  smallEffort: "medium",
  normalEffort: "high",
  riskEffort: "high",
  xhighPolicy: "failed-or-explicit",
  postReview: "risk-only",
  subscriptionOnly: true
});

const EFFORTS = new Set(["low", "medium", "high"]);
const AUDIT_EFFORTS = new Set(["medium", "high"]);
const XHIGH_POLICIES = new Set(["never", "explicit", "failed-or-explicit"]);
const POST_REVIEW_POLICIES = new Set(["off", "risk-only", "always"]);
const COST_PROFILES = new Set(["economy", "balanced", "strict", "custom"]);
const CLAUDE_MODELS = new Set(["fable", "opusplan", "opus", "sonnet"]);
const CODEX_MODELS = new Set(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
const PROFILE_IMPLEMENTATION_THRESHOLDS = Object.freeze({ economy: 5, balanced: 3, strict: 2, custom: 3 });

function intInRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Config must be an object");
  }

  const profile = typeof input.costProfile === "string" ? input.costProfile : DEFAULT_CONFIG.costProfile;
  const config = {
    ...DEFAULT_CONFIG,
    ...input,
    implementationFileThreshold: input.implementationFileThreshold ?? PROFILE_IMPLEMENTATION_THRESHOLDS[profile] ?? DEFAULT_CONFIG.implementationFileThreshold,
    version: 2,
    subscriptionOnly: true
  };
  if (!COST_PROFILES.has(config.costProfile)) throw new Error("costProfile is invalid");
  const boolKeys = [
    "planAuditEnabled", "auditScope", "auditHighRisk", "auditUnverified",
    "auditAmbiguity", "auditExplicit", "allowReaudit", "skipNearLimit"
  ];
  for (const key of boolKeys) {
    if (typeof config[key] !== "boolean") throw new Error(`${key} must be true or false`);
  }

  if (!CLAUDE_MODELS.has(config.claudeModel)) throw new Error("claudeModel is not supported");
  for (const key of ["smallModel", "normalModel", "riskModel", "normalAuditModel", "highRiskAuditModel"]) {
    if (!CODEX_MODELS.has(config[key])) throw new Error(`${key} must be a GPT-5.6 model`);
  }
  intInRange(config.fileThreshold, 2, 20, "fileThreshold");
  intInRange(config.implementationFileThreshold, 2, 20, "implementationFileThreshold");
  intInRange(config.packetTokens, 200, 2000, "packetTokens");
  intInRange(config.responseTokens, 150, 1200, "responseTokens");
  intInRange(config.normalAudits, 0, 2, "normalAudits");

  for (const key of ["smallEffort", "normalEffort", "riskEffort"]) {
    if (!EFFORTS.has(config[key])) throw new Error(`${key} is invalid`);
  }
  for (const key of ["normalAuditEffort", "highRiskAuditEffort"]) {
    if (!AUDIT_EFFORTS.has(config[key])) throw new Error(`${key} must be medium or high`);
  }
  if (!XHIGH_POLICIES.has(config.xhighPolicy)) throw new Error("xhighPolicy is invalid");
  if (!POST_REVIEW_POLICIES.has(config.postReview)) throw new Error("postReview is invalid");

  return config;
}

function triggerLines(config) {
  const lines = [];
  if (config.auditScope) lines.push(`- The implementation is expected to touch ${config.fileThreshold} or more files, multiple packages, or multiple services.`);
  if (config.auditHighRisk) lines.push("- The task affects authentication, authorization, security, data migration, concurrency, data loss, a public API, a persistent schema, or infrastructure.");
  if (config.auditUnverified) lines.push("- The plan depends on an important assumption Claude could not verify from the repository, tests, or documentation.");
  if (config.auditAmbiguity) lines.push("- Claude has low confidence in the root cause or sees two materially different implementation approaches.");
  if (config.auditExplicit) lines.push("- The user explicitly requests a deep plan or an independent plan review.");
  return lines.length ? lines.join("\n") : "- No automatic trigger is enabled; audit only when the user explicitly overrides this policy.";
}

function xhighRule(policy) {
  if (policy === "never") return "Never select `xhigh`; require the user to change this policy first.";
  if (policy === "explicit") return "Use `xhigh` only when the user explicitly requests it.";
  return "Use `xhigh` only when a prior `high` Codex pass failed for a concrete reason or the user explicitly requests it.";
}

function postReviewRule(policy) {
  if (policy === "off") return "Do not automatically run post-implementation Codex review.";
  if (policy === "always") return "Run one independent Codex review after every delegated implementation, while still respecting subscription limits.";
  return "Reserve post-implementation Codex review for high-risk changes, a materially changed plan, failing validation, or a large diff.";
}

export function generateRules(rawConfig) {
  const config = validateConfig(rawConfig);
  const auditSection = config.planAuditEnabled ? `
## Economical analysis and plan audit

Claude owns the initial repository analysis and implementation plan. Before editing, request a read-only Codex plan audit whenever at least one enabled trigger applies:

${triggerLines(config)}

Skip the audit only for read-only explanations, documentation-only work, or a single obvious low-risk operation below the configured scope threshold. A built-in Explore or Plan subagent may gather evidence, but it never substitutes for a qualifying independent Codex audit. Re-evaluate the audit triggers immediately after exploration returns.

For a qualifying audit:

1. Claude first gathers evidence: relevant files, symbols, tests, constraints, and known unknowns.
2. Compress the packet to at most ${config.packetTokens} tokens: objective, evidence, assumptions, proposed steps, validation, and rollback concerns. Never forward the full conversation or large files.
3. Delegate one fresh foreground read-only task through \`codex:codex-rescue\`.
4. Start the delegated prompt with four metadata lines so the local router logger can record the decision without storing the prompt: \`ROUTER_MODE: audit\`, \`ROUTER_CLASS: normal | high-risk\`, \`ROUTER_MODEL: <model>\`, and \`ROUTER_EFFORT: <effort>\`.
5. For scope, unverified assumptions, ambiguity, or explicit review when no high-risk domain applies, use \`--model ${config.normalAuditModel} --effort ${config.normalAuditEffort}\`. For authentication, authorization, security, migration, concurrency, data loss, public API compatibility, persistent schema, or infrastructure, use \`--model ${config.highRiskAuditModel} --effort ${config.highRiskAuditEffort}\`.
6. Never use \`xhigh\` for plan audit unless the user explicitly requests it.
7. Limit the response to ${config.responseTokens} tokens with: \`VERDICT: APPROVE | REVISE | BLOCK\`, at most three \`CRITICAL\` findings, at most two \`OMISSIONS\`, and one \`SIMPLER OPTION\` or \`none\`.
8. Claude verifies every finding against the repository. On \`APPROVE\`, proceed. On \`REVISE\`, revise once and proceed. On \`BLOCK\`, perform targeted research${config.allowReaudit ? " and allow at most one re-audit only after a material plan change" : " without an automatic re-audit"}.

Cost guardrails:

- At most ${config.normalAudits} normal plan audit${config.normalAudits === 1 ? "" : "s"} per task${config.allowReaudit ? " plus one exceptional re-audit after BLOCK" : ""}.
- Never launch multiple reviewers or review one plan with several models.
- ${config.skipNearLimit ? "Skip non-critical review when either subscription is close to its limit." : "Do not silently skip a qualifying review because of limits; report the constraint."}
- ${postReviewRule(config.postReview)}
` : `
## Plan audit

Automatic Codex plan audit is disabled. Claude may request one only when the user explicitly asks for it.
`;

  return `# Automatic Claude–Codex routing

Use Claude Code as the single user interface and choose the executor automatically. Do not ask the user to select Claude versus Codex, a model, or an effort level unless organization policy or model availability makes a choice unavoidable.

## Billing and authentication boundary

- Use only subscription-authenticated Claude Code and the local subscription-authenticated Codex CLI.
- Never add or use \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, a custom base URL, or a pay-as-you-go fallback.
- If a subscription is unavailable or its limit is reached, use the other subscribed agent when appropriate; otherwise report the limit instead of enabling billed API usage.
- Organization and repository data-handling rules override this routing policy. Never send code to OpenAI when a managed or project rule forbids it.

## Mandatory routing gate

At the start of every user turn, after any Explore or Plan subagent returns, and again before the first file edit:

1. Estimate the implementation scope by distinct files and architectural layers.
2. Classify the work as Claude-only, Codex plan audit, Codex implementation, or both audit then implementation.
3. Apply the numeric thresholds below as requirements, not suggestions. When scope is uncertain, use the higher class.
4. A built-in Claude Explore, Plan, or general-purpose subagent does not count as Codex involvement.
5. If a qualifying Codex route is skipped because Codex is unavailable, a subscription limit is reached, or data policy forbids it, state that reason explicitly. Do not silently keep qualifying work in Claude.
6. The local hook may deny the threshold-reaching Edit or Write once. Treat that denial as a routing checkpoint: delegate or resume through \`codex:codex-rescue\`; retry directly only after stating a concrete allowed skip reason.

## Keep work in Claude only when

- The request is conversational, read-only, exploratory, architectural, or product-oriented and no implementation is requested.
- A low-risk implementation is expected to touch fewer than ${config.implementationFileThreshold} files, stays within one architectural layer, and Claude has not already made an unsuccessful attempt.
- Claude is gathering the minimum evidence needed to prepare a qualifying Codex audit or implementation packet.

Use the Claude model, effort, and thinking settings selected in the current Claude UI. This routing policy does not override the active Claude session picker. Plan uncertain or high-impact work before editing.
${auditSection}
## Delegate implementation to Codex

Delegation is mandatory when any of these conditions applies:

- The implementation is expected to touch ${config.implementationFileThreshold} or more distinct files.
- The implementation crosses two or more architectural layers such as UI plus state, state plus API, frontend plus backend, or code plus persistent schema.
- The task is a bounded repository-wide refactor, migration, or repeated mechanical change.
- A reproducible bug, failing validation, or clear diagnosis target requires a multi-step coding pass.
- Claude has already made one unsuccessful implementation attempt, the user reports the fix is still wrong, or a corrective follow-up materially changes the approach.
- Independent implementation or review is likely to catch mistakes in a risky or large diff.

Do not wait for the user to ask for Codex when one of these conditions is already true. A later clarification that stays inside an active delegated task should continue or resume that Codex task instead of silently switching back to Claude implementation.

Delegate through the installed \`codex:codex-rescue\` subagent. Do not duplicate the same implementation in both agents unless one is explicitly the reviewer.

Start every delegated Codex implementation or post-implementation review prompt with these four lines before the actual task: \`ROUTER_MODE: implementation\`, \`ROUTER_CLASS: small | multi-file | high-risk\`, \`ROUTER_MODEL: <selected model>\`, and \`ROUTER_EFFORT: <selected effort>\`. These lines are local routing metadata; do not include user text in them.

## Codex model and effort policy

The plan-audit rules above take precedence. These mappings apply to implementation, debugging, and post-implementation review:

- Small bounded low-risk task: \`--model ${config.smallModel} --effort ${config.smallEffort}\`.
- Normal multi-file implementation or debugging: \`--model ${config.normalModel} --effort ${config.normalEffort}\`.
- Security, authentication, migration, concurrency, data-loss risk, or deeply ambiguous failures: \`--model ${config.riskModel} --effort ${config.riskEffort}\`.
- ${xhighRule(config.xhighPolicy)}
- If an explicitly selected model is unavailable, retry once with the current default Codex model; never fall back to an API provider.
- Prefer foreground for a small bounded task and background for long, open-ended work.

${postReviewRule(config.postReview)} Do not enable a global stop-time review loop.
`;
}

export function embedConfig(config) {
  const validated = validateConfig(config);
  return `${META_START}${JSON.stringify(validated)}${META_END}\n${generateRules(validated)}`;
}

export function extractConfig(content) {
  const start = content.indexOf(META_START);
  const end = content.indexOf(META_END, start + META_START.length);
  if (start === -1 || end === -1) return null;
  try {
    return validateConfig(JSON.parse(content.slice(start + META_START.length, end)));
  } catch {
    return null;
  }
}

function revision(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function readText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function backupName(prefix = "agent-routing") {
  return `${prefix}.${new Date().toISOString().replaceAll(":", "-")}.md`;
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.routing-ui-${process.pid}-${Date.now()}.tmp`;
  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

export async function saveConfig(filePath, backupDir, rawConfig, expectedRevision) {
  const config = validateConfig(rawConfig);
  const previous = await readText(filePath);
  if (expectedRevision !== undefined && revision(previous) !== expectedRevision) {
    const error = new Error("Routing file changed outside the UI. Reload before saving.");
    error.code = "CONFLICT";
    throw error;
  }

  let backupPath = null;
  if (previous) {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    backupPath = path.join(backupDir, backupName());
    await writeFile(backupPath, previous, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  const content = embedConfig(config);
  await atomicWrite(filePath, content);
  return { config, revision: revision(content), backupPath };
}

async function backupFiles(backupDir) {
  try {
    const names = await readdir(backupDir);
    return names.filter((name) => name.endsWith(".md")).sort().reverse();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function restoreLatest(filePath, backupDir, expectedRevision) {
  const current = await readText(filePath);
  if (revision(current) !== expectedRevision) {
    const error = new Error("Routing file changed outside the UI. Reload before restoring.");
    error.code = "CONFLICT";
    throw error;
  }
  const backups = await backupFiles(backupDir);
  if (!backups.length) throw new Error("No backup is available yet");
  const selected = path.join(backupDir, backups[0]);
  const restored = await readText(selected);
  if (!restored) throw new Error("Latest backup is empty");

  if (current) {
    const safetyCopy = path.join(backupDir, backupName("pre-restore"));
    await writeFile(safetyCopy, current, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  await atomicWrite(filePath, restored);
  return {
    config: extractConfig(restored) || DEFAULT_CONFIG,
    managed: Boolean(extractConfig(restored)),
    revision: revision(restored),
    restoredFrom: selected
  };
}

async function getState() {
  const content = await readText(ROUTING_PATH);
  const stored = extractConfig(content);
  const backups = await backupFiles(BACKUP_DIR);
  return {
    config: stored || DEFAULT_CONFIG,
    managed: Boolean(stored),
    fileExists: Boolean(content),
    routingPath: ROUTING_PATH,
    revision: revision(content),
    backupCount: backups.length,
    preview: generateRules(stored || DEFAULT_CONFIG)
  };
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'"
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > REQUEST_LIMIT) {
        reject(new Error("Request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".zip": "application/zip",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

async function serveStatic(urlPath, response) {
  const requested = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const normalized = path.normalize(requested);
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
    });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") sendJson(response, 404, { error: "Not found" });
    else throw error;
  }
}

function createHandler(port) {
  const allowedOrigins = new Set([`http://${HOST}:${port}`, `http://localhost:${port}`]);
  return async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}:${port}`);
      if (url.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/config" && request.method === "GET") {
        sendJson(response, 200, await getState());
        return;
      }
      if (url.pathname === "/api/setup/status" && request.method === "GET") {
        sendJson(response, 200, await getSetupStatus());
        return;
      }
      if (url.pathname === "/api/setup/action" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        const body = await readJson(request);
        const terminalActions = new Set(["install-claude", "auth-claude", "install-codex", "auth-codex", "live-test"]);
        if (terminalActions.has(body.action)) {
          sendJson(response, 200, { action: body.action, ...(await launchSetupTerminalAction(body.action)), status: await getSetupStatus() });
          return;
        }
        if (body.action === "install-plugin") {
          sendJson(response, 200, { action: body.action, ...(await installBridgePlugin()) });
          return;
        }
        if (body.action === "apply-configuration") {
          const current = await getState();
          const policy = await saveConfig(ROUTING_PATH, BACKUP_DIR, current.config, current.revision);
          const telemetry = await installTelemetry();
          let toolPath = null;
          try { toolPath = await ensureClaudeToolPath(); } catch { /* Codex may not be installed yet. */ }
          sendJson(response, 200, { action: body.action, policy, telemetry, toolPath, status: await getSetupStatus() });
          return;
        }
        if (body.action === "self-check") {
          sendJson(response, 200, { action: body.action, ...(await runBridgeSelfCheck()) });
          return;
        }
        sendJson(response, 400, { error: "Unknown setup action" });
        return;
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 20;
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))) {
          sendJson(response, 400, { error: "Invalid history date range" });
          return;
        }
        const [history, routing] = await Promise.all([
          getUsageHistory({ limit, from, to }),
          readRoutingTelemetry({ limit: 200, from, to })
        ]);
        sendJson(response, 200, { ...history, routing });
        return;
      }
      if (url.pathname === "/api/delegated-tasks" && request.method === "GET") {
        sendJson(response, 200, await readDelegatedTasks());
        return;
      }
      if (url.pathname === "/api/delegated-tasks/cancel" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        const body = await readJson(request);
        const result = await cancelDelegatedTask(body.id);
        sendJson(response, 200, { ...result, live: await readDelegatedTasks() });
        return;
      }
      if (url.pathname === "/api/delegated-tasks/retry" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        const body = await readJson(request);
        const result = await retryDelegatedTask(body.id);
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === "/api/telemetry/status" && request.method === "GET") {
        sendJson(response, 200, await getTelemetryStatus());
        return;
      }
      if (url.pathname === "/api/telemetry/install" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        sendJson(response, 200, await installTelemetry());
        return;
      }
      if (url.pathname === "/api/telemetry/repair" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        sendJson(response, 200, await installTelemetry());
        return;
      }
      if (url.pathname === "/api/telemetry/uninstall" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        sendJson(response, 200, await uninstallTelemetry());
        return;
      }
      if (url.pathname === "/api/preview" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        const body = await readJson(request);
        sendJson(response, 200, { preview: generateRules(body.config) });
        return;
      }
      if (url.pathname === "/api/save" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        const body = await readJson(request);
        const result = await saveConfig(ROUTING_PATH, BACKUP_DIR, body.config, body.revision);
        sendJson(response, 200, { ...result, routingPath: ROUTING_PATH, preview: generateRules(result.config) });
        return;
      }
      if (url.pathname === "/api/restore" && request.method === "POST") {
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return sendJson(response, 403, { error: "Origin rejected" });
        const body = await readJson(request);
        const result = await restoreLatest(ROUTING_PATH, BACKUP_DIR, body.revision);
        sendJson(response, 200, { ...result, routingPath: ROUTING_PATH, preview: generateRules(result.config) });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "Unknown API route" });
        return;
      }
      await serveStatic(url.pathname, response);
    } catch (error) {
      const statusCode = error.code === "CONFLICT" ? 409 : 400;
      sendJson(response, statusCode, { error: error.message || "Unexpected error" });
    }
  };
}

export async function startServer({ port = Number(process.env.PORT) || 4177, openBrowser = true } = {}) {
  const server = createServer(createHandler(port));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  const url = `http://${HOST}:${port}`;
  console.log(`Claude–Codex Router UI: ${url}`);
  console.log(`Routing file: ${ROUTING_PATH}`);
  if (openBrowser && process.platform === "darwin") {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
  }
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startServer({ openBrowser: !process.argv.includes("--no-open") }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
