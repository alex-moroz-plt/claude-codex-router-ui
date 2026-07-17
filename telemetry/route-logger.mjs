#!/usr/bin/env node

import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const HISTORY_DIR = process.env.ROUTER_HISTORY_DIR || path.join(homedir(), ".claude", "router-history");
const STATE_DIR = path.join(HISTORY_DIR, "state");
const EVENTS_FILE = path.join(HISTORY_DIR, "events.jsonl");
const POLICY_STATUS_FILE = path.join(HISTORY_DIR, "policy-status.json");
const ROUTING_FILE = process.env.CLAUDE_ROUTING_FILE || path.join(homedir(), ".claude", "rules", "agent-routing.md");
const VERSION = 1;

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function textFrom(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function parseRouterTags(prompt) {
  const tags = {};
  for (const line of String(prompt || "").split(/\r?\n/).slice(0, 20)) {
    const match = line.match(/^ROUTER_(MODE|CLASS|MODEL|EFFORT):\s*(.+?)\s*$/i);
    if (match) tags[match[1].toLowerCase()] = match[2].trim().slice(0, 100);
  }
  return tags;
}

function isCodexAgent(input) {
  const tool = String(input.tool_name || "").toLowerCase();
  const agent = input.tool_input || {};
  const type = String(agent.subagent_type || agent.agent_type || agent.type || "").toLowerCase();
  return (tool === "agent" || tool === "task") && (type.includes("codex") || textFrom(agent.prompt).includes("ROUTER_MODE:"));
}

function verdictFrom(value) {
  const match = textFrom(value).match(/\b(?:VERDICT\s*:\s*)?(APPROVE|REVISE|BLOCK)\b/i);
  return match ? match[1].toUpperCase() : null;
}

async function routingGateConfig() {
  let implementationFileThreshold = 3;
  let fileThreshold = 4;
  try {
    const content = await readFile(ROUTING_FILE, "utf8");
    const match = content.match(/<!-- ROUTING_UI_CONFIG\n([\s\S]*?)\nROUTING_UI_CONFIG -->/);
    const config = match ? JSON.parse(match[1]) : {};
    const legacyThresholds = { economy: 5, balanced: 3, strict: 2, custom: 3 };
    if (Number.isInteger(config.implementationFileThreshold)) implementationFileThreshold = config.implementationFileThreshold;
    else if (config.costProfile in legacyThresholds) implementationFileThreshold = legacyThresholds[config.costProfile];
    if (Number.isInteger(config.fileThreshold)) fileThreshold = config.fileThreshold;
  } catch {
    // The generated policy may not exist yet; safe balanced defaults keep the reminder useful.
  }
  return { implementationFileThreshold, fileThreshold };
}

function routingGateContext({ implementationFileThreshold, fileThreshold }) {
  return [
    "Claude–Codex routing gate is active for this turn.",
    `Before the first edit, estimate distinct files and architectural layers. Codex implementation is mandatory at ${implementationFileThreshold}+ files, across 2+ layers, or after one unsuccessful implementation/corrective attempt.`,
    `A plan touching ${fileThreshold}+ files, multiple layers, or an ambiguous/high-risk area requires the configured Codex plan audit.`,
    "Claude Explore, Plan, and general-purpose subagents may gather evidence but do not replace qualifying Codex involvement.",
    "If a qualifying Codex route is skipped, state the concrete availability, subscription, or data-policy reason instead of silently implementing in Claude."
  ].join(" ");
}

function editPathFrom(input, cwd) {
  const tool = String(input.tool_name || "").toLowerCase();
  if (!["edit", "write", "notebookedit"].includes(tool)) return null;
  const candidate = input.tool_input?.file_path || input.tool_input?.notebook_path || input.tool_input?.path;
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  return path.resolve(cwd || process.cwd(), candidate);
}

async function readState(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function writeState(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temp, filePath);
}

async function appendEvent(input, state, fields) {
  const event = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    eventType: fields.eventType,
    route: fields.route,
    sessionId: String(input.session_id || state?.sessionId || "unknown").slice(0, 200),
    turnId: state?.turnId || null,
    decisionId: fields.decisionId || state?.decisionId || null,
    cwd: String(input.cwd || state?.cwd || "").slice(0, 1000) || null,
    taskClass: fields.taskClass || state?.taskClass || null,
    model: fields.model || state?.model || null,
    effort: fields.effort || state?.effort || null,
    verdict: fields.verdict || null,
    outcome: fields.outcome || null
  };
  await appendFile(EVENTS_FILE, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const sessionId = String(input.session_id || "unknown");
  const statePath = path.join(STATE_DIR, `${safeSegment(sessionId)}.json`);
  const hook = String(input.hook_event_name || "");
  let state = await readState(statePath);

  if (hook === "InstructionsLoaded") {
    const loadedPath = String(input.file_path || input.path || input.source || "");
    if (loadedPath.includes("agent-routing.md") || textFrom(input).includes(ROUTING_FILE)) {
      await writeState(POLICY_STATUS_FILE, { loadedAt: new Date().toISOString(), path: loadedPath || ROUTING_FILE });
    }
    return;
  }

  if (hook === "UserPromptSubmit") {
    state = {
      sessionId,
      turnId: `${safeSegment(sessionId)}-${Date.now()}`,
      cwd: input.cwd || null,
      route: "pending",
      implementationDelegated: false,
      observedEditFiles: [],
      implementationGateWarned: false,
      startedAt: new Date().toISOString()
    };
    await writeState(statePath, state);
    const gateConfig = await routingGateConfig();
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: routingGateContext(gateConfig)
      }
    })}\n`);
    return;
  }

  if (hook === "PreToolUse" && isCodexAgent(input)) {
    const tags = parseRouterTags(input.tool_input?.prompt);
    const route = tags.mode === "audit" ? "audit" : "delegated";
    const decisionId = String(input.tool_use_id || `${state?.turnId || safeSegment(sessionId)}-${Date.now()}`).slice(0, 240);
    state ||= { sessionId, turnId: `${safeSegment(sessionId)}-${Date.now()}`, cwd: input.cwd || null };
    state = {
      ...state,
      route,
      decisionId,
      taskClass: tags.class || null,
      model: tags.model || null,
      effort: tags.effort || null,
      implementationDelegated: tags.mode !== "audit" || state.implementationDelegated === true,
      delegatedAt: new Date().toISOString()
    };
    await writeState(statePath, state);
    await appendEvent(input, state, { eventType: "decision", route, decisionId });
    return;
  }

  if (hook === "PreToolUse") {
    const editPath = editPathFrom(input, input.cwd || state?.cwd);
    if (editPath && state && !state.implementationDelegated) {
      const observed = new Set(Array.isArray(state.observedEditFiles) ? state.observedEditFiles : []);
      observed.add(editPath);
      state = { ...state, observedEditFiles: [...observed] };
      const { implementationFileThreshold } = await routingGateConfig();
      if (observed.size >= implementationFileThreshold && !state.implementationGateWarned) {
        state.implementationGateWarned = true;
        await writeState(statePath, state);
        process.stdout.write(`${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `Claude–Codex Router observed ${observed.size} distinct edited files, reaching the ${implementationFileThreshold}-file implementation threshold. Delegate or resume the implementation through codex:codex-rescue before continuing. If Codex is unavailable or policy forbids it, state that concrete reason; one explicit retry is allowed to avoid a dead end.`
          }
        })}\n`);
        return;
      }
      await writeState(statePath, state);
    }
    return;
  }

  if ((hook === "PostToolUse" || hook === "PostToolUseFailure") && isCodexAgent(input) && state?.route) {
    const failure = hook === "PostToolUseFailure";
    await appendEvent(input, state, {
      eventType: "outcome",
      route: state.route,
      outcome: failure ? "failed" : "completed",
      verdict: failure || state.route !== "audit" ? null : verdictFrom(input.tool_response)
    });
    return;
  }

  if (hook === "Stop" && state) {
    if (state.route === "pending") {
      await appendEvent(input, state, { eventType: "decision", route: "claude-only" });
    }
    await rm(statePath, { force: true });
  }
}

main().catch(() => {
  // Telemetry is best-effort and must never interrupt Claude Code.
  process.exitCode = 0;
});
