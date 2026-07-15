import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_LOGGER = path.join(ROOT, "telemetry", "route-logger.mjs");
const MARKER = "--claude-codex-router-telemetry-v1";
const HOOK_SPECS = [
  ["UserPromptSubmit", ""],
  ["PreToolUse", "Agent|Task"],
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
  return {
    eventCount: events.length,
    decisionCount: events.filter((event) => event.eventType === "decision").length,
    lastEventAt: events.at(-1)?.timestamp || null
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

export async function readRoutingTelemetry({ limit = 50, ...overrides } = {}) {
  const paths = telemetryPaths(overrides);
  const text = await readOptional(paths.eventsFile);
  const events = text.trim() ? text.trim().split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : [];
  const decisions = events.filter((event) => event.eventType === "decision");
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
