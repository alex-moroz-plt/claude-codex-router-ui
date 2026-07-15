import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { getTelemetryStatus } from "./telemetry-manager.mjs";

const PLUGIN_ID = "codex@openai-codex";
const MARKETPLACE_ID = "openai-codex";
const MARKETPLACE_SOURCE = "openai/codex-plugin-cc";
const MAX_OUTPUT = 64 * 1024;

export function setupPaths(overrides = {}) {
  const home = overrides.home || homedir();
  const claudeDir = overrides.claudeDir || path.join(home, ".claude");
  const stateRoot = overrides.stateRoot || path.join(home, ".claude-codex-router");
  const toolsRoot = overrides.toolsRoot || path.join(stateRoot, "tools");
  return {
    home,
    claudeDir,
    stateRoot,
    toolsRoot,
    toolsBin: overrides.toolsBin || path.join(toolsRoot, "node_modules", ".bin"),
    actionsDir: overrides.actionsDir || path.join(stateRoot, "setup-actions"),
    backupsDir: overrides.backupsDir || path.join(stateRoot, "backups"),
    stateFile: overrides.stateFile || path.join(stateRoot, "setup-state.json"),
    settingsFile: overrides.settingsFile || process.env.CLAUDE_SETTINGS_FILE || path.join(claudeDir, "settings.json"),
    routingFile: overrides.routingFile || process.env.CLAUDE_ROUTING_FILE || path.join(claudeDir, "rules", "agent-routing.md"),
    marketplacesFile: overrides.marketplacesFile || path.join(claudeDir, "plugins", "known_marketplaces.json"),
    installedPluginsFile: overrides.installedPluginsFile || path.join(claudeDir, "plugins", "installed_plugins.json"),
    projectsDir: overrides.projectsDir || path.join(claudeDir, "projects"),
    nodeBin: overrides.nodeBin || process.execPath,
    managedFiles: overrides.managedFiles || [
      path.join(claudeDir, "managed-settings.json"),
      "/Library/Application Support/ClaudeCode/managed-settings.json"
    ],
    binaryOverrides: overrides.binaryOverrides || {},
    launcher: overrides.launcher
  };
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return "";
    throw error;
  }
}

async function readJsonOptional(filePath, fallback = {}) {
  const text = await readOptional(filePath);
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function exists(filePath, mode = fsConstants.F_OK) {
  if (!filePath) return false;
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

async function versionCandidates(base, name) {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name, "bin", name));
  } catch {
    return [];
  }
}

async function executableCandidates(name, paths) {
  const fromPath = String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, name));
  const common = [
    path.join(paths.toolsBin, name),
    path.join(paths.home, ".local", "bin", name),
    path.join(paths.home, ".claude", "local", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`
  ];
  if (name === "codex") common.unshift("/Applications/Codex.app/Contents/Resources/codex");
  if (name === "claude") common.unshift("/Applications/Claude.app/Contents/Resources/claude");
  if (name === "npm") common.unshift(path.join(path.dirname(paths.nodeBin), "npm"));
  const nvm = await versionCandidates(path.join(paths.home, ".nvm", "versions", "node"), name);
  const mise = await versionCandidates(path.join(paths.home, ".local", "share", "mise", "installs", "node"), name);
  return [...new Set([paths.binaryOverrides[name], ...common, ...fromPath, ...nvm.reverse(), ...mise.reverse()].filter(Boolean))];
}

export async function findExecutable(name, overrides = {}) {
  const paths = setupPaths(overrides);
  for (const candidate of await executableCandidates(name, paths)) {
    if (await exists(candidate, fsConstants.X_OK)) return candidate;
  }
  return null;
}

function safeEnv(extraPath = []) {
  const env = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) {
    delete env[key];
  }
  env.PATH = [...extraPath, String(env.PATH || "").split(path.delimiter)].flat().filter(Boolean).join(path.delimiter);
  return env;
}

export function runCommand(binary, args = [], { cwd, env, timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: env || safeEnv([path.dirname(binary)]),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-MAX_OUTPUT);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeout);
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function versionLabel(result) {
  return result?.code === 0 ? (result.stdout || result.stderr).split(/\r?\n/)[0].trim().slice(0, 120) : null;
}

async function pluginState(paths) {
  const [marketplaces, installed, settings] = await Promise.all([
    readJsonOptional(paths.marketplacesFile),
    readJsonOptional(paths.installedPluginsFile),
    readJsonOptional(paths.settingsFile)
  ]);
  const records = Array.isArray(installed.plugins?.[PLUGIN_ID]) ? installed.plugins[PLUGIN_ID] : [];
  const record = records.at(-1) || null;
  const installPath = record?.installPath || null;
  const agentPath = installPath ? path.join(installPath, "agents", "codex-rescue.md") : null;
  const companionPath = installPath ? path.join(installPath, "scripts", "codex-companion.mjs") : null;
  return {
    marketplaceInstalled: Boolean(marketplaces[MARKETPLACE_ID]),
    installed: Boolean(record && installPath && await exists(installPath)),
    enabled: settings.enabledPlugins?.[PLUGIN_ID] === true,
    version: record?.version || null,
    installPath,
    agentAvailable: await exists(agentPath),
    companionAvailable: await exists(companionPath),
    companionPath
  };
}

async function managedRestrictions(paths) {
  let strictKnownMarketplaces = null;
  let allowManagedHooksOnly = false;
  let source = null;
  for (const filePath of paths.managedFiles) {
    const parsed = await readJsonOptional(filePath, null);
    if (!parsed) continue;
    if (Array.isArray(parsed.strictKnownMarketplaces)) strictKnownMarketplaces = parsed.strictKnownMarketplaces.length;
    if (parsed.allowManagedHooksOnly === true) allowManagedHooksOnly = true;
    if (strictKnownMarketplaces !== null || allowManagedHooksOnly) source = filePath;
  }
  return { strictKnownMarketplaces, allowManagedHooksOnly, source };
}

async function hasClaudeActivity(paths) {
  try {
    const entries = await readdir(paths.projectsDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function parseClaudeAuth(result) {
  if (!result) return { state: "unknown", verified: false, method: null };
  if (result.code !== 0) return { state: "signed-out", verified: true, method: null };
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* Claude may emit text in older versions. */ }
  const loggedIn = parsed ? Boolean(parsed.loggedIn ?? parsed.authenticated ?? parsed.status === "logged-in") : true;
  const raw = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const subscription = String(parsed?.subscriptionType || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const method = subscription ? `claude-${subscription}` : raw.includes("sso") || raw.includes("enterprise") ? "corporate-sso" : "claude-subscription";
  return { state: loggedIn ? "verified" : "signed-out", verified: true, method: loggedIn ? method : null };
}

function parseCodexAuth(result) {
  if (!result || result.code !== 0) return { state: "signed-out", verified: Boolean(result), method: null, subscriptionOnly: false };
  const raw = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const method = raw.includes("chatgpt") ? "chatgpt" : raw.includes("api") ? "api-key" : raw.includes("access token") ? "access-token" : "unknown";
  return { state: "verified", verified: true, method, subscriptionOnly: method === "chatgpt" || method === "access-token" };
}

async function apiKeyRisk(paths) {
  const settings = await readJsonOptional(paths.settingsFile);
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"];
  return keys.filter((key) => typeof settings.env?.[key] === "string" && settings.env[key].trim()).map((key) => key);
}

export async function getSetupStatus(overrides = {}) {
  const paths = setupPaths(overrides);
  const [claudeBin, codexBin, npmBin, gitBin, plugin, telemetry, restrictions, activity, desktopInstalled, routingText, savedState, keyRisk] = await Promise.all([
    findExecutable("claude", overrides),
    findExecutable("codex", overrides),
    findExecutable("npm", overrides),
    findExecutable("git", overrides),
    pluginState(paths),
    getTelemetryStatus({ home: paths.home, settingsFile: paths.settingsFile }),
    managedRestrictions(paths),
    hasClaudeActivity(paths),
    exists("/Applications/Claude.app"),
    readOptional(paths.routingFile),
    readJsonOptional(paths.stateFile),
    apiKeyRisk(paths)
  ]);

  const basePath = [path.dirname(paths.nodeBin), codexBin && path.dirname(codexBin), claudeBin && path.dirname(claudeBin), paths.toolsBin].filter(Boolean);
  const commandEnv = safeEnv(basePath);
  const [nodeVersion, npmVersion, gitVersion, claudeVersion, claudeAuthResult, codexVersion, codexAuthResult] = await Promise.all([
    runCommand(paths.nodeBin, ["--version"], { env: commandEnv }).catch(() => null),
    npmBin ? runCommand(npmBin, ["--version"], { env: commandEnv }).catch(() => null) : null,
    gitBin ? runCommand(gitBin, ["--version"], { env: commandEnv }).catch(() => null) : null,
    claudeBin ? runCommand(claudeBin, ["--version"], { env: commandEnv }).catch(() => null) : null,
    claudeBin ? runCommand(claudeBin, ["auth", "status"], { env: commandEnv, timeout: 20_000 }).catch(() => null) : null,
    codexBin ? runCommand(codexBin, ["--version"], { env: commandEnv }).catch(() => null) : null,
    codexBin ? runCommand(codexBin, ["login", "status"], { env: commandEnv, timeout: 20_000 }).catch(() => null) : null
  ]);

  let claudeAuth = parseClaudeAuth(claudeAuthResult);
  if (!claudeBin && activity) claudeAuth = { state: "detected", verified: false, method: "existing-desktop-session" };
  const codexAuth = parseCodexAuth(codexAuthResult);
  const routingInstalled = routingText.includes("ROUTING_UI_CONFIG") && routingText.includes("# Automatic Claude–Codex routing");
  const telemetryReady = ["installed", "active"].includes(telemetry.state);
  const claudeReady = claudeAuth.state === "verified" || claudeAuth.state === "detected";
  const codexReady = Boolean(codexBin && codexAuth.state === "verified" && codexAuth.subscriptionOnly);
  const pluginReady = plugin.installed && plugin.enabled && plugin.agentAvailable && plugin.companionAvailable;
  const configReady = routingInstalled && telemetryReady;
  const bridgeReady = claudeReady && codexReady && pluginReady && configReady;
  const steps = [
    { id: "runtime", ready: Boolean(nodeVersion?.code === 0 && npmBin), state: npmBin ? "ready" : "partial" },
    { id: "claude", ready: claudeReady, state: claudeAuth.state },
    { id: "codex", ready: codexReady, state: codexAuth.state },
    { id: "plugin", ready: pluginReady, state: pluginReady ? "ready" : plugin.installed ? "partial" : "missing" },
    { id: "config", ready: configReady, state: configReady ? "ready" : "missing" },
    { id: "bridge", ready: Boolean(bridgeReady && savedState.bridgeCheck?.ready), state: bridgeReady && savedState.bridgeCheck?.ready ? "verified" : bridgeReady ? "ready-to-check" : "blocked" }
  ];

  return {
    generatedAt: new Date().toISOString(),
    progress: { completed: steps.filter((step) => step.ready).length, total: steps.length, ready: bridgeReady && Boolean(savedState.bridgeCheck?.ready) },
    steps,
    runtime: {
      ready: Boolean(nodeVersion?.code === 0 && npmBin),
      node: { path: paths.nodeBin, version: versionLabel(nodeVersion) },
      npm: { path: npmBin, version: versionLabel(npmVersion) },
      git: { path: gitBin, version: versionLabel(gitVersion) }
    },
    claude: {
      installed: Boolean(claudeBin || desktopInstalled || activity),
      cliAvailable: Boolean(claudeBin),
      desktopInstalled,
      path: claudeBin,
      version: versionLabel(claudeVersion),
      auth: claudeAuth
    },
    codex: {
      installed: Boolean(codexBin),
      path: codexBin,
      version: versionLabel(codexVersion),
      auth: codexAuth
    },
    plugin,
    configuration: {
      routingInstalled,
      routingPath: paths.routingFile,
      telemetryState: telemetry.state,
      telemetryReady
    },
    bridge: {
      ready: bridgeReady,
      check: savedState.bridgeCheck || null,
      liveTest: savedState.liveTest || null
    },
    restrictions,
    subscriptionBoundary: { clean: keyRisk.length === 0, conflictingSettings: keyRisk }
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function writeTerminalScript(paths, name, title, commands) {
  await mkdir(paths.actionsDir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(paths.actionsDir, `${name}.command`);
  const script = `#!/bin/zsh
set -e
clear
print -r -- ${shellQuote(title)}
print -r -- "------------------------------------------------------------"
${commands.join("\n")}
print
print -r -- "Готово. Поверніться в Router UI та натисніть Recheck."
print -r -- "Натисніть Enter, щоб закрити це вікно."
read
`;
  await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o700 });
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

async function launchScript(scriptPath, paths) {
  if (paths.launcher) return paths.launcher(scriptPath);
  if (process.platform !== "darwin") throw new Error("Interactive setup launcher is currently available on macOS only");
  const child = spawn("/usr/bin/open", ["-a", "Terminal", scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
  return { launched: true, scriptPath };
}

export async function launchSetupTerminalAction(action, overrides = {}) {
  const paths = setupPaths(overrides);
  const status = await getSetupStatus(overrides);
  let title;
  let commands;
  if (action === "install-claude") {
    title = "Claude Code · офіційне встановлення";
    commands = [
      "print -r -- \"Завантажуємо офіційний installer з claude.ai. sudo не використовується.\"",
      "TMP_INSTALLER=$(mktemp)",
      "/usr/bin/curl -fsSL https://claude.ai/install.sh -o \"$TMP_INSTALLER\"",
      "/bin/bash \"$TMP_INSTALLER\"",
      "/bin/rm -f \"$TMP_INSTALLER\""
    ];
  } else if (action === "auth-claude") {
    if (!status.claude.path) throw new Error("Claude Code CLI is not installed yet");
    title = "Claude Code · корпоративний SSO";
    commands = [
      "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL",
      `print -r -- "Браузер відкриє корпоративний SSO. Router не бачить і не зберігає токени."`,
      `${shellQuote(status.claude.path)} auth login --sso`
    ];
  } else if (action === "install-codex") {
    if (!status.runtime.npm.path) throw new Error("npm is unavailable; rerun the desktop bootstrap installer");
    title = "Codex CLI · user-local install";
    commands = [
      `export PATH=${shellQuote(path.dirname(paths.nodeBin))}:$PATH`,
      `mkdir -p ${shellQuote(paths.toolsRoot)}`,
      `print -r -- "Встановлюємо @openai/codex у user-space. sudo та API keys не потрібні."`,
      `${shellQuote(status.runtime.npm.path)} install --prefix ${shellQuote(paths.toolsRoot)} @openai/codex@latest`
    ];
  } else if (action === "auth-codex") {
    if (!status.codex.path) throw new Error("Codex CLI is not installed yet");
    title = "Codex · ChatGPT subscription login";
    commands = [
      "unset OPENAI_API_KEY OPENAI_BASE_URL",
      `print -r -- "Браузер відкриє ChatGPT OAuth. Не обирайте API key login."`,
      ...(status.codex.auth.method === "api-key" ? [`${shellQuote(status.codex.path)} logout`] : []),
      `${shellQuote(status.codex.path)} login`
    ];
  } else if (action === "live-test") {
    if (!status.plugin.companionPath || !status.codex.auth.subscriptionOnly) throw new Error("Install and authenticate the bridge before the live test");
    title = "Claude → Codex bridge · мінімальний live handshake";
    const pathValue = [path.dirname(status.codex.path), path.dirname(paths.nodeBin), paths.toolsBin, "/usr/bin", "/bin"].join(path.delimiter);
    commands = [
      `export PATH=${shellQuote(pathValue)}`,
      "unset OPENAI_API_KEY OPENAI_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL",
      `print -r -- "Цей тест використає невелику кількість Codex subscription tokens і не змінюватиме файли."`,
      `${shellQuote(paths.nodeBin)} ${shellQuote(status.plugin.companionPath)} task --fresh --model gpt-5.6-luna --effort medium ${shellQuote("Return exactly CODEX BRIDGE OK. Do not read or modify files and do not use tools.")}`
    ];
  } else {
    throw new Error("Unknown setup terminal action");
  }
  const scriptPath = await writeTerminalScript(paths, action, title, commands);
  return launchScript(scriptPath, paths);
}

async function backupSettings(paths, text) {
  if (!text) return null;
  await mkdir(paths.backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(paths.backupsDir, `settings.${stamp}.json`);
  await writeFile(backupPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return backupPath;
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temp, filePath);
  await chmod(filePath, 0o600);
}

export async function ensureClaudeToolPath(overrides = {}) {
  const paths = setupPaths(overrides);
  const [codexBin, claudeBin] = await Promise.all([findExecutable("codex", overrides), findExecutable("claude", overrides)]);
  if (!codexBin) throw new Error("Codex CLI is not installed");
  const previousText = await readOptional(paths.settingsFile);
  let settings = {};
  if (previousText.trim()) {
    try { settings = JSON.parse(previousText); } catch { throw new Error(`Claude settings contain invalid JSON: ${paths.settingsFile}`); }
  }
  const current = String(settings.env?.PATH || process.env.PATH || "");
  const entries = [path.dirname(codexBin), path.dirname(paths.nodeBin), claudeBin && path.dirname(claudeBin), paths.toolsBin, ...current.split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean);
  const mergedPath = [...new Set(entries)].join(path.delimiter);
  if (settings.env?.PATH === mergedPath) return { changed: false, backupPath: null, path: mergedPath };
  const backupPath = await backupSettings(paths, previousText);
  settings.env = { ...(settings.env || {}), PATH: mergedPath };
  await atomicJson(paths.settingsFile, settings);
  return { changed: true, backupPath, path: mergedPath };
}

function commandFailure(label, result) {
  const detail = (result.stderr || result.stdout || `exit ${result.code}`).slice(-2500);
  return new Error(`${label} failed: ${detail}`);
}

export async function installBridgePlugin(overrides = {}) {
  const paths = setupPaths(overrides);
  const status = await getSetupStatus(overrides);
  if (!status.claude.path) throw new Error("Claude Code CLI is required to install the plugin automatically");
  if (status.restrictions.strictKnownMarketplaces === 0 && !status.plugin.marketplaceInstalled) {
    throw new Error("Corporate Claude policy blocks all additional plugin marketplaces. Ask the administrator to allow openai/codex-plugin-cc.");
  }
  const toolPath = await ensureClaudeToolPath(overrides);
  const env = safeEnv([path.dirname(status.claude.path), path.dirname(status.codex.path || ""), path.dirname(paths.nodeBin), paths.toolsBin]);
  const actions = [];
  if (!status.plugin.marketplaceInstalled) {
    const added = await runCommand(status.claude.path, ["plugin", "marketplace", "add", MARKETPLACE_SOURCE, "--scope", "user"], { env, timeout: 180_000 });
    if (added.code !== 0) throw commandFailure("Marketplace install", added);
    actions.push("marketplace-installed");
  }
  if (!status.plugin.installed) {
    const installed = await runCommand(status.claude.path, ["plugin", "install", PLUGIN_ID, "--scope", "user"], { env, timeout: 180_000 });
    if (installed.code !== 0) throw commandFailure("Plugin install", installed);
    actions.push("plugin-installed");
  } else if (!status.plugin.enabled) {
    const enabled = await runCommand(status.claude.path, ["plugin", "enable", PLUGIN_ID, "--scope", "user"], { env, timeout: 60_000 });
    if (enabled.code !== 0) throw commandFailure("Plugin enable", enabled);
    actions.push("plugin-enabled");
  }
  return { actions, toolPath, status: await getSetupStatus(overrides) };
}

export async function runBridgeSelfCheck(overrides = {}) {
  const paths = setupPaths(overrides);
  const status = await getSetupStatus(overrides);
  if (!status.plugin.companionPath || !status.plugin.agentAvailable) throw new Error("Codex plugin runtime or codex-rescue agent is missing");
  if (!status.codex.path) throw new Error("Codex CLI is missing");
  const env = safeEnv([path.dirname(status.codex.path), path.dirname(paths.nodeBin), paths.toolsBin, "/usr/bin", "/bin"]);
  const result = await runCommand(paths.nodeBin, [status.plugin.companionPath, "setup", "--json"], { env, cwd: paths.home, timeout: 60_000 });
  if (result.code !== 0) throw commandFailure("Bridge self-check", result);
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error("Bridge self-check returned invalid JSON"); }
  const check = {
    checkedAt: new Date().toISOString(),
    ready: Boolean(report.ready && status.plugin.agentAvailable),
    nodeAvailable: Boolean(report.node?.available),
    codexAvailable: Boolean(report.codex?.available),
    codexAuthenticated: Boolean(report.auth?.loggedIn),
    authMethod: report.auth?.authMethod || null,
    pluginAgentAvailable: status.plugin.agentAvailable
  };
  const state = await readJsonOptional(paths.stateFile);
  await atomicJson(paths.stateFile, { ...state, bridgeCheck: check });
  return { check, status: await getSetupStatus(overrides) };
}
