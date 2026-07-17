import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_LOGGER = path.join(ROOT, "telemetry", "route-logger.mjs");
const MARKER = "--claude-codex-router-telemetry-v1";
const HOOK_SPECS = [
  ["InstructionsLoaded", ""],
  ["UserPromptSubmit", ""],
  ["PreToolUse", "Agent|Task|Edit|Write|NotebookEdit"],
  ["PostToolUse", "Agent|Task"],
  ["PostToolUseFailure", "Agent|Task"],
  ["Stop", ""]
];

function quoteShell(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function telemetryPaths(overrides = {}) {
  const home = overrides.home || homedir();
  const hooksDir = overrides.hooksDir || process.env.ROUTER_HOOKS_DIR || path.join(home, ".claude", "router-hooks");
  const historyDir = overrides.historyDir || process.env.ROUTER_HISTORY_DIR || path.join(home, ".claude", "router-history");
  return {
    settingsFile: overrides.settingsFile || process.env.CLAUDE_SETTINGS_FILE || path.join(home, ".claude", "settings.json"),
    hooksDir,
    historyDir,
    loggerFile: overrides.loggerFile || path.join(hooksDir, "route-logger.mjs"),
    manifestFile: overrides.manifestFile || path.join(hooksDir, "installation.json"),
    eventsFile: overrides.eventsFile || path.join(historyDir, "events.jsonl"),
    policyStatusFile: overrides.policyStatusFile || path.join(historyDir, "policy-status.json"),
    backupsDir: overrides.backupsDir || path.join(hooksDir, "backups"),
    sourceLogger: overrides.sourceLogger || SOURCE_LOGGER,
    nodePath: overrides.nodePath || process.execPath
  };
}

function commandFor(paths) {
  return `${quoteShell(paths.nodePath)} ${quoteShell(paths.loggerFile)} ${MARKER}`;
}

function isOurs(hook, paths) {
  const command = String(hook?.command || "");
  return command.includes(MARKER) || command.includes(paths.loggerFile);
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function timestampValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function routerTagsFromSummary(summary) {
  const tags = {};
  for (const match of String(summary || "").matchAll(/\bROUTER_(MODE|CLASS|MODEL|EFFORT):\s*([^\s]+)/gi)) {
    tags[match[1].toLowerCase()] = match[2].slice(0, 100);
  }
  return tags;
}

async function stateFilesIn(root) {
  const files = [];
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return files;
    throw error;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    files.push(path.join(root, workspace.name, "state.json"));
  }
  return files;
}

async function codexStateFiles(pluginDataRoot, fallbackStateRoot) {
  const roots = [fallbackStateRoot];
  try {
    const plugins = await readdir(pluginDataRoot, { withFileTypes: true });
    for (const plugin of plugins) {
      if (plugin.isDirectory() && plugin.name.toLowerCase().includes("codex")) {
        roots.push(path.join(pluginDataRoot, plugin.name, "state"));
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
  }
  return (await Promise.all(roots.map(stateFilesIn))).flat();
}

function processIsAlive(pid, pidChecker) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pidChecker) return Boolean(pidChecker(pid));
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readDelegatedJobRecords({
  home = homedir(),
  pluginDataRoot = process.env.CLAUDE_PLUGIN_DATA_ROOT || path.join(home, ".claude", "plugins", "data"),
  fallbackStateRoot = process.env.CODEX_COMPANION_STATE_ROOT || path.join(tmpdir(), "codex-companion"),
  stateFiles
} = {}) {
  const files = stateFiles || await codexStateFiles(pluginDataRoot, fallbackStateRoot);
  const jobsById = new Map();
  await Promise.all(files.map(async (filePath) => {
    let state;
    try {
      state = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES" || error instanceof SyntaxError) return;
      throw error;
    }
    for (const job of Array.isArray(state.jobs) ? state.jobs : []) {
      if (!job || typeof job !== "object" || !String(job.id || "").startsWith("task-")) continue;
      if (job.jobClass && job.jobClass !== "task") continue;
      const previous = jobsById.get(job.id);
      if (!previous || timestampValue(job.updatedAt || job.createdAt) > timestampValue(previous.job.updatedAt || previous.job.createdAt)) {
        jobsById.set(job.id, { job, stateFile: filePath });
      }
    }
  }));
  return Promise.all([...jobsById.values()].map(async (record) => {
    const jobFile = path.join(path.dirname(record.stateFile), "jobs", `${record.job.id}.json`);
    let hasStoredRequest = false;
    try {
      const storedJob = JSON.parse(await readFile(jobFile, "utf8"));
      hasStoredRequest = Boolean(storedJob?.request && typeof storedJob.request === "object" && !Array.isArray(storedJob.request));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES" && !(error instanceof SyntaxError)) throw error;
    }
    return { ...record, hasStoredRequest };
  }));
}

export async function findDelegatedTaskControl(id, {
  pidChecker,
  now = Date.now(),
  ...options
} = {}) {
  const taskId = String(id || "");
  if (!/^task-[a-zA-Z0-9_-]{3,150}$/.test(taskId)) return null;
  const record = (await readDelegatedJobRecords(options)).find(({ job }) => job.id === taskId);
  if (!record || !["queued", "running"].includes(record.job.status)) return null;
  const workspaceRoot = typeof record.job.workspaceRoot === "string" ? record.job.workspaceRoot : "";
  if (!workspaceRoot) return null;
  const stateRoot = path.dirname(path.dirname(record.stateFile));
  const pluginDataDir = path.basename(stateRoot) === "state" ? path.dirname(stateRoot) : null;
  const referenceAt = timestampValue(record.job.updatedAt || record.job.startedAt || record.job.createdAt);
  const pidAlive = processIsAlive(record.job.pid, pidChecker);
  const tags = routerTagsFromSummary(record.job.summary);
  const threadId = typeof record.job.threadId === "string" ? record.job.threadId : "";
  const retryMode = record.hasStoredRequest ? "replay" : threadId ? "resume" : null;
  return {
    id: taskId,
    status: record.job.status,
    stalled: !pidAlive && now - referenceAt > 10_000,
    canRetry: Boolean(retryMode),
    retryMode,
    workspaceRoot,
    pluginDataDir,
    sessionId: typeof record.job.sessionId === "string" ? record.job.sessionId : null,
    threadId: threadId || null,
    model: tags.model || null,
    effort: tags.effort || null,
    write: record.job.write === true
  };
}

export async function readDelegatedTasks({
  pidChecker,
  now = Date.now(),
  ...options
} = {}) {
  const records = await readDelegatedJobRecords(options);

  const activeStatuses = new Set(["queued", "running"]);
  const items = records.flatMap(({ job, hasStoredRequest }) => {
    if (!activeStatuses.has(job.status)) return [];
    const referenceAt = timestampValue(job.updatedAt || job.startedAt || job.createdAt);
    const pidAlive = processIsAlive(job.pid, pidChecker);
    const stalled = !pidAlive && now - referenceAt > 10_000;
    const tags = routerTagsFromSummary(job.summary);
    const workspaceRoot = typeof job.workspaceRoot === "string" ? job.workspaceRoot : "";
    return [{
      id: String(job.id).slice(0, 160),
      status: stalled ? "stalled" : job.status,
      reportedStatus: job.status,
      pidAlive,
      canCancel: Boolean(workspaceRoot),
      canRetry: stalled && Boolean(hasStoredRequest || job.threadId) && Boolean(workspaceRoot),
      retryMode: hasStoredRequest ? "replay" : job.threadId ? "resume" : null,
      title: typeof job.title === "string" ? job.title.slice(0, 120) : "Codex task",
      project: workspaceRoot ? path.basename(workspaceRoot) : "Local workspace",
      workspaceRoot: workspaceRoot.slice(0, 1000) || null,
      sessionId: String(job.sessionId || "").slice(0, 200) || null,
      threadId: String(job.threadId || "").slice(0, 200) || null,
      route: tags.mode === "audit" ? "audit" : "delegated",
      taskClass: tags.class || null,
      model: tags.model || null,
      effort: tags.effort || null,
      write: job.write === true,
      phase: typeof job.phase === "string" ? job.phase.slice(0, 80) : null,
      pid: Number.isInteger(job.pid) ? job.pid : null,
      createdAt: timestampValue(job.createdAt) ? new Date(timestampValue(job.createdAt)).toISOString() : null,
      startedAt: timestampValue(job.startedAt) ? new Date(timestampValue(job.startedAt)).toISOString() : null,
      updatedAt: referenceAt ? new Date(referenceAt).toISOString() : null
    }];
  }).sort((left, right) => timestampValue(right.startedAt || right.createdAt) - timestampValue(left.startedAt || left.createdAt));

  const counts = { queued: 0, running: 0, stalled: 0 };
  for (const item of items) counts[item.status] += 1;
  return { generatedAt: new Date(now).toISOString(), counts, items };
}

async function readSettings(filePath) {
  const text = await readOptional(filePath);
  if (!text.trim()) return {};
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error(`Claude settings contain invalid JSON: ${filePath}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Claude settings must contain a JSON object: ${filePath}`);
  }
  return settings;
}

function stripOwnHooks(settings, paths) {
  const result = structuredClone(settings);
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) return result;
  for (const [event, groups] of Object.entries(result.hooks)) {
    if (!Array.isArray(groups)) continue;
    result.hooks[event] = groups.flatMap((group) => {
      if (!group || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((hook) => !isOurs(hook, paths));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  if (!Object.keys(result.hooks).length) delete result.hooks;
  return result;
}

function addOwnHooks(settings, paths) {
  const result = stripOwnHooks(settings, paths);
  result.hooks ||= {};
  const command = commandFor(paths);
  for (const [event, matcher] of HOOK_SPECS) {
    result.hooks[event] ||= [];
    result.hooks[event].push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command, timeout: 10 }]
    });
  }
  return result;
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temp, filePath);
  await chmod(filePath, 0o600);
}

async function backupSettings(paths) {
  const text = await readOptional(paths.settingsFile);
  if (!text) return null;
  await mkdir(paths.backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(paths.backupsDir, `settings.${stamp}.json`);
  await writeFile(backupPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return backupPath;
}

async function hashFile(filePath) {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function ownHookCoverage(settings, paths) {
  const command = commandFor(paths);
  return HOOK_SPECS.map(([event, matcher]) => {
    const groups = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
    const present = groups.some((group) => (
      String(group?.matcher || "") === matcher &&
      Array.isArray(group?.hooks) &&
      group.hooks.some((hook) => hook?.type === "command" && hook.command === command)
    ));
    return { event, present };
  });
}

async function managedHookRestriction(paths) {
  const candidates = [
    path.join(path.dirname(paths.settingsFile), "managed-settings.json"),
    "/Library/Application Support/ClaudeCode/managed-settings.json"
  ];
  const managedDir = "/Library/Application Support/ClaudeCode/managed-settings.d";
  try {
    for (const name of await readdir(managedDir)) {
      if (name.endsWith(".json")) candidates.push(path.join(managedDir, name));
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
  }
  for (const filePath of candidates) {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (parsed?.allowManagedHooksOnly === true) return filePath;
    } catch (error) {
      if (!['ENOENT', 'EACCES'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

async function eventStats(paths) {
  const text = await readOptional(paths.eventsFile);
  const events = text.trim() ? text.trim().split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : [];
  let policyStatus = null;
  try { policyStatus = JSON.parse(await readFile(paths.policyStatusFile, "utf8")); } catch { /* Not observed in a Claude session yet. */ }
  return {
    eventCount: events.length,
    decisionCount: events.filter((event) => event.eventType === "decision").length,
    lastEventAt: events.at(-1)?.timestamp || null,
    policyLoadedAt: policyStatus?.loadedAt || null
  };
}

export async function getTelemetryStatus(overrides = {}) {
  const paths = telemetryPaths(overrides);
  const settings = await readSettings(paths.settingsFile);
  const coverage = ownHookCoverage(settings, paths);
  const configured = coverage.every((item) => item.present);
  const [sourceHash, installedHash, restriction, stats] = await Promise.all([
    hashFile(paths.sourceLogger),
    hashFile(paths.loggerFile),
    managedHookRestriction(paths),
    eventStats(paths)
  ]);
  const loggerCurrent = Boolean(sourceHash && installedHash && sourceHash === installedHash);
  let state = "not-installed";
  if (restriction) state = "blocked-by-organization";
  else if (configured && loggerCurrent) state = stats.eventCount ? "active" : "installed";
  else if (configured || installedHash) state = "needs-repair";
  return {
    state,
    configured,
    loggerCurrent,
    coverage,
    organizationRestriction: restriction,
    settingsPath: paths.settingsFile,
    loggerPath: paths.loggerFile,
    historyPath: paths.eventsFile,
    ...stats
  };
}

export async function installTelemetry(overrides = {}) {
  const paths = telemetryPaths(overrides);
  const settings = await readSettings(paths.settingsFile);
  const backupPath = await backupSettings(paths);
  await mkdir(paths.hooksDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.historyDir, { recursive: true, mode: 0o700 });
  await copyFile(paths.sourceLogger, paths.loggerFile);
  await chmod(paths.loggerFile, 0o700);
  await atomicJson(paths.settingsFile, addOwnHooks(settings, paths));
  await atomicJson(paths.manifestFile, {
    version: 1,
    installedAt: new Date().toISOString(),
    settingsPath: paths.settingsFile,
    loggerPath: paths.loggerFile,
    command: commandFor(paths)
  });
  return { ...(await getTelemetryStatus(overrides)), backupPath };
}

export async function uninstallTelemetry(overrides = {}) {
  const paths = telemetryPaths(overrides);
  const settings = await readSettings(paths.settingsFile);
  const backupPath = await backupSettings(paths);
  await atomicJson(paths.settingsFile, stripOwnHooks(settings, paths));
  await rm(paths.loggerFile, { force: true });
  await rm(paths.manifestFile, { force: true });
  return { ...(await getTelemetryStatus(overrides)), backupPath, historyKept: true };
}

export async function readRoutingTelemetry({ limit = 50, from = null, to = null, ...overrides } = {}) {
  const paths = telemetryPaths(overrides);
  const text = await readOptional(paths.eventsFile);
  const events = text.trim() ? text.trim().split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : [];
  const fromValue = timestampValue(from);
  const toValue = timestampValue(to);
  const inRange = (event) => {
    const value = timestampValue(event.timestamp);
    return (!fromValue || value >= fromValue) && (!toValue || value < toValue);
  };
  const decisions = events.filter((event) => event.eventType === "decision" && inRange(event));
  const outcomes = new Map(events.filter((event) => event.eventType === "outcome").map((event) => [event.decisionId || event.turnId, event]));
  const items = decisions.slice(-Math.max(1, Math.min(Number(limit) || 50, 200))).reverse().map((event) => ({
    ...event,
    outcome: outcomes.get(event.decisionId || event.turnId)?.outcome || null,
    verdict: outcomes.get(event.decisionId || event.turnId)?.verdict || null
  }));
  const totals = { "claude-only": 0, delegated: 0, audit: 0 };
  for (const event of decisions) if (event.route in totals) totals[event.route] += 1;
  return { items, totals, decisionCount: decisions.length };
}
