#!/usr/bin/env node

import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const HISTORY_DIR = process.env.ROUTER_HISTORY_DIR || path.join(homedir(), ".claude", "router-history");
const STATE_DIR = path.join(HISTORY_DIR, "state");
const EVENTS_FILE = path.join(HISTORY_DIR, "events.jsonl");
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

  if (hook === "UserPromptSubmit") {
    state = {
      sessionId,
      turnId: `${safeSegment(sessionId)}-${Date.now()}`,
      cwd: input.cwd || null,
      route: "pending",
      startedAt: new Date().toISOString()
    };
    await writeState(statePath, state);
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
      delegatedAt: new Date().toISOString()
    };
    await writeState(statePath, state);
    await appendEvent(input, state, { eventType: "decision", route, decisionId });
    return;
  }

  if ((hook === "PostToolUse" || hook === "PostToolUseFailure") && isCodexAgent(input) && state?.route) {
    const failure = hook === "PostToolUseFailure";
    await appendEvent(input, state, {
      eventType: "outcome",
      route: state.route,
      outcome: failure ? "failed" : "completed",
      verdict: failure ? null : verdictFrom(input.tool_response)
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
