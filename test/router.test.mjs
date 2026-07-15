import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  embedConfig,
  extractConfig,
  generateRules,
  restoreLatest,
  saveConfig,
  validateConfig
} from "../server.mjs";
import { summarizeClaudeRecords, summarizeCodexRecords } from "../usage-history.mjs";
import {
  getTelemetryStatus,
  installTelemetry,
  readRoutingTelemetry,
  telemetryPaths,
  uninstallTelemetry
} from "../telemetry-manager.mjs";
import {
  ensureClaudeToolPath,
  getSetupStatus,
  launchSetupTerminalAction,
  runBridgeSelfCheck,
  setupPaths
} from "../setup-manager.mjs";

test("balanced defaults generate subscription-only economical routing", () => {
  const rules = generateRules(DEFAULT_CONFIG);
  assert.match(rules, /Never add or use `ANTHROPIC_API_KEY`/);
  assert.match(rules, /touch 4 or more files/);
  assert.match(rules, /at most 600 tokens/);
  assert.match(rules, /Limit the response to 400 tokens/);
  assert.match(rules, /--model gpt-5\.6-terra --effort medium/);
  assert.match(rules, /--model gpt-5\.6-sol --effort high/);
  assert.match(rules, /Small bounded low-risk task: `--model gpt-5\.6-luna/);
  assert.doesNotMatch(rules, /gpt-5\.4|gpt-5\.3|gpt-5\.2/);
  assert.match(rules, /prior `high` Codex pass failed/);
  assert.match(rules, /selected in the current Claude UI/);
  assert.match(rules, /ROUTER_MODE: audit/);
  assert.match(rules, /ROUTER_MODE: implementation/);
  assert.doesNotMatch(rules, /Use the `opusplan` model alias/);
});

test("embedded UI config round-trips", () => {
  const custom = { ...DEFAULT_CONFIG, fileThreshold: 7, postReview: "off" };
  assert.deepEqual(extractConfig(embedConfig(custom)), custom);
});

test("invalid or expensive audit values are rejected", () => {
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, normalAuditEffort: "xhigh" }), /medium or high/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, riskEffort: "xhigh" }), /riskEffort is invalid/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, smallModel: "gpt-5.4-mini" }), /GPT-5.6 model/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, claudeModel: "custom-model" }), /not supported/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, packetTokens: 99999 }), /packetTokens/);
});

test("save creates a backup and restore returns previous policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "router-ui-test-"));
  const file = path.join(root, "rules", "agent-routing.md");
  const backups = path.join(root, "backups");
  const emptyRevision = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  const first = await saveConfig(file, backups, DEFAULT_CONFIG, emptyRevision);
  const changed = { ...DEFAULT_CONFIG, fileThreshold: 8 };
  const second = await saveConfig(file, backups, changed, first.revision);
  assert.ok(second.backupPath);
  assert.equal(extractConfig(await readFile(file, "utf8")).fileThreshold, 8);

  const restored = await restoreLatest(file, backups, second.revision);
  assert.equal(restored.config.fileThreshold, 4);
});

test("PWA manifest exposes standalone PNG icons and local start URL", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const manifest = JSON.parse(await readFile(path.join(root, "public", "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192" && icon.type === "image/png"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
  for (const icon of manifest.icons) {
    const info = await stat(path.join(root, "public", icon.src));
    assert.ok(info.size > 500);
  }
});

test("npm package metadata exposes an explicit CLI without publishing generated artifacts", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const cli = await readFile(path.join(root, "bin", "claude-codex-router.mjs"), "utf8");
  assert.equal(pkg.name, "@alex_moroz/claude-codex-router");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.bin, { "claude-codex-router": "bin/claude-codex-router.mjs" });
  assert.ok(pkg.files.includes("bin/"));
  assert.ok(!pkg.files.includes("NPM_PUBLISH_CHECKLIST.md"));
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.equal(pkg.scripts.prepare, undefined);
  assert.ok(pkg.files.every((entry) => !entry.startsWith("public/downloads")));
  assert.match(cli, /^#!\/usr\/bin\/env node/);
  for (const command of ["start", "install", "service", "uninstall", "open", "doctor", "build-portable"]) {
    assert.match(cli, new RegExp(`command === "${command}"`));
  }
  assert.match(cli, /--start-at-login/);
  assert.match(cli, /No LaunchAgent was installed/);
});

test("service worker keeps API calls network-only", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const worker = await readFile(path.join(root, "public", "sw.js"), "utf8");
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /caches\.match\(INDEX_FALLBACK\)/);
  assert.match(worker, /fetch\(event\.request\)[\s\S]+catch\(\(\) => caches\.match\(event\.request\)\)/);
});

test("every model control is a dropdown with GPT-5.6 coding choices", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const html = await readFile(path.join(root, "public", "index.html"), "utf8");
  const modelIds = ["normalAuditModel", "highRiskAuditModel", "smallModel", "normalModel", "riskModel"];
  for (const id of modelIds) assert.match(html, new RegExp(`<select id="${id}"(?:\\s|>)`));
  assert.doesNotMatch(html, /<(?:input|select)[^>]+id="claudeModel"/);
  assert.match(html, /Селектор біля поля вводу є джерелом правди/);
  assert.doesNotMatch(html, /gpt-5\.[0-4]/);
});

test("HTML and service worker use the same cache-busting build", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const html = await readFile(path.join(root, "public", "index.html"), "utf8");
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const worker = await readFile(path.join(root, "public", "sw.js"), "utf8");
  const htmlBuild = html.match(/app\.js\?v=([0-9-]+)/)?.[1];
  const workerBuild = worker.match(/const BUILD = "([0-9-]+)"/)?.[1];
  assert.ok(htmlBuild);
  assert.equal(htmlBuild, workerBuild);
  assert.match(html, new RegExp(`styles\\.css\\?v=${htmlBuild}`));
  assert.match(app, new RegExp(`sw\\.js\\?v=${htmlBuild}`));
});

test("zero-setup wizard explains every layer and the bootstrap can install a verified local runtime", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const html = await readFile(path.join(root, "public", "index.html"), "utf8");
  const server = await readFile(path.join(root, "server.mjs"), "utf8");
  const installer = await readFile(path.join(root, "Install Desktop PWA.command"), "utf8");
  for (const label of ["Локальний runtime", "корпоративний SSO", "ChatGPT subscription", "bridge plugin", "Routing policy + telemetry", "Перевірка з’єднання"]) {
    assert.ok(html.includes(label), `setup wizard should include ${label}`);
  }
  assert.match(server, /\/api\/setup\/status/);
  assert.match(server, /\/api\/setup\/action/);
  assert.match(installer, /nodejs\.org\/dist\/\$NODE_VERSION/);
  assert.match(installer, /shasum -a 256 -c/);
  assert.match(installer, /Application Support\/ClaudeCodexRouter\/runtime/);
  assert.doesNotMatch(installer, /sudo/);
  assert.match(installer, /--start-at-login\) START_AT_LOGIN=1/);
  assert.match(installer, /if \[\[ "\$START_AT_LOGIN" == "1" \]\]/);
});

test("start-at-login persistence is explicit opt-in", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const cli = await readFile(path.join(root, "bin", "claude-codex-router.mjs"), "utf8");
  const installer = await readFile(path.join(root, "Install Desktop PWA.command"), "utf8");
  assert.match(cli, /startAtLogin = process\.argv\.includes\("--start-at-login"\)/);
  assert.match(cli, /startAtLogin \? "  <key>RunAtLoad<\/key><true\/>\\n  <key>KeepAlive<\/key><true\/>\\n" : ""/);
  assert.match(installer, /START_AT_LOGIN="\$\{START_AT_LOGIN:-0\}"/);
  assert.match(installer, /if \[\[ "\$START_AT_LOGIN" == "1" \]\]; then[\s\S]+Add :RunAtLoad bool true[\s\S]+Add :KeepAlive bool true[\s\S]+fi/);
});

test("local Claude and Codex token counters are summarized without double counting", () => {
  const claude = summarizeClaudeRecords([
    { sessionId: "claude-1", cwd: "/tmp/demo", timestamp: "2026-07-15T10:00:00Z" },
    { type: "ai-title", sessionId: "claude-1", aiTitle: "Fix auth flow" },
    { sessionId: "claude-1", timestamp: "2026-07-15T10:01:00Z", message: { model: "claude-sonnet-5", usage: { input_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 11 } } },
    { sessionId: "claude-1", timestamp: "2026-07-15T10:02:00Z", message: { model: "claude-sonnet-5", usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 13, output_tokens: 17 } } }
  ]);
  assert.deepEqual(claude.usage, { input: 5, cached: 25, output: 28, total: 58 });
  assert.equal(claude.task, "Fix auth flow");
  assert.equal(claude.project, "demo");
  assert.equal(claude.cacheIsSubset, false);

  const codex = summarizeCodexRecords([
    { type: "session_meta", timestamp: "2026-07-15T10:00:00Z", payload: { id: "codex-1", cwd: "/tmp/demo" } },
    { type: "turn_context", timestamp: "2026-07-15T10:01:00Z", payload: { model: "gpt-5.6-terra", effort: "high" } },
    { type: "event_msg", timestamp: "2026-07-15T10:01:30Z", payload: { type: "user_message", message: "# My request for Codex:\nFix the stale PWA cache" } },
    { type: "event_msg", timestamp: "2026-07-15T10:02:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 80, cached_input_tokens: 30, output_tokens: 20, total_tokens: 100 } } } },
    { type: "event_msg", timestamp: "2026-07-15T10:03:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 140, cached_input_tokens: 60, output_tokens: 35, total_tokens: 175 } } } }
  ]);
  assert.deepEqual(codex.usage, { input: 140, cached: 60, output: 35, total: 175 });
  assert.equal(codex.cacheIsSubset, true);
  assert.equal(codex.effort, "high");
  assert.equal(codex.task, "Fix the stale PWA cache");
});

test("portable installer archive is generated and excludes local credentials", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const archive = path.join(root, "public", "downloads", "Claude-Codex-Router-UI.zip");
  const info = await stat(archive);
  assert.ok(info.size > 10_000);
});

function runLogger(loggerPath, historyDir, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [loggerPath, "--claude-codex-router-telemetry-v1"], {
      env: { ...process.env, ROUTER_HISTORY_DIR: historyDir },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `logger exited ${code}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

test("telemetry install and repair preserve unrelated Claude hooks, and uninstall removes only ours", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "router-telemetry-install-"));
  const paths = telemetryPaths({ home, nodePath: process.execPath });
  await mkdir(path.dirname(paths.settingsFile), { recursive: true });
  const unrelated = { type: "command", command: "/usr/bin/true" };
  await writeFile(paths.settingsFile, JSON.stringify({
    enabledPlugins: { "codex@openai-codex": true },
    hooks: { UserPromptSubmit: [{ hooks: [unrelated] }] }
  }));

  const installed = await installTelemetry({ home, nodePath: process.execPath });
  assert.equal(installed.state, "installed");
  assert.equal(installed.configured, true);
  assert.ok(installed.backupPath);
  const afterInstall = JSON.parse(await readFile(paths.settingsFile, "utf8"));
  assert.equal(afterInstall.enabledPlugins["codex@openai-codex"], true);
  assert.ok(afterInstall.hooks.UserPromptSubmit[0].hooks.some((hook) => hook.command === unrelated.command));

  await installTelemetry({ home, nodePath: process.execPath });
  const afterRepair = JSON.parse(await readFile(paths.settingsFile, "utf8"));
  for (const groups of Object.values(afterRepair.hooks)) {
    const ours = groups.flatMap((group) => group.hooks || []).filter((hook) => hook.command?.includes("--claude-codex-router-telemetry-v1"));
    assert.equal(ours.length, 1);
  }

  const removed = await uninstallTelemetry({ home, nodePath: process.execPath });
  assert.equal(removed.state, "not-installed");
  assert.equal(removed.historyKept, true);
  const afterUninstall = JSON.parse(await readFile(paths.settingsFile, "utf8"));
  assert.equal(afterUninstall.hooks.UserPromptSubmit[0].hooks[0].command, unrelated.command);
  assert.equal(JSON.stringify(afterUninstall).includes("--claude-codex-router-telemetry-v1"), false);
});

test("route logger records only routing metadata for audit and Claude-only decisions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "router-telemetry-events-"));
  const overrides = { home, nodePath: process.execPath };
  const paths = telemetryPaths(overrides);
  await installTelemetry(overrides);

  const common = { session_id: "claude-audit-session", cwd: "/tmp/private-project" };
  await runLogger(paths.loggerFile, paths.historyDir, { ...common, hook_event_name: "UserPromptSubmit", prompt: "SECRET USER PROMPT" });
  await runLogger(paths.loggerFile, paths.historyDir, {
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue",
      prompt: "ROUTER_MODE: audit\nROUTER_CLASS: high-risk\nROUTER_MODEL: gpt-5.6-sol\nROUTER_EFFORT: high\nSECRET CODE"
    }
  });
  await runLogger(paths.loggerFile, paths.historyDir, {
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "codex:codex-rescue" },
    tool_response: "VERDICT: APPROVE\nSECRET REVIEW"
  });
  await runLogger(paths.loggerFile, paths.historyDir, { ...common, hook_event_name: "Stop" });

  const claudeOnly = { session_id: "claude-only-session", cwd: "/tmp/second-project" };
  await runLogger(paths.loggerFile, paths.historyDir, { ...claudeOnly, hook_event_name: "UserPromptSubmit", prompt: "ANOTHER SECRET" });
  await runLogger(paths.loggerFile, paths.historyDir, { ...claudeOnly, hook_event_name: "Stop" });

  const routing = await readRoutingTelemetry({ ...overrides, limit: 20 });
  assert.deepEqual(routing.totals, { "claude-only": 1, delegated: 0, audit: 1 });
  const audit = routing.items.find((item) => item.route === "audit");
  assert.equal(audit.model, "gpt-5.6-sol");
  assert.equal(audit.effort, "high");
  assert.equal(audit.verdict, "APPROVE");
  const rawLog = await readFile(paths.eventsFile, "utf8");
  assert.doesNotMatch(rawLog, /SECRET|USER PROMPT|REVIEW/);
  assert.equal((await getTelemetryStatus(overrides)).state, "active");
});

async function writeExecutable(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o700 });
  await chmod(filePath, 0o700);
}

async function createReadySetupFixture() {
  const home = await mkdtemp(path.join(tmpdir(), "router-setup-ready-"));
  const binDir = path.join(home, "fake-bin");
  const claudeBin = path.join(binDir, "claude");
  const codexBin = path.join(binDir, "codex");
  const npmBin = path.join(binDir, "npm");
  const gitBin = path.join(binDir, "git");
  await writeExecutable(claudeBin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.210 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team"}'; exit 0; fi
exit 0
`);
  await writeExecutable(codexBin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.144.2"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
exit 0
`);
  await writeExecutable(npmBin, "#!/bin/sh\necho 11.5.2\n");
  await writeExecutable(gitBin, "#!/bin/sh\necho 'git version 2.50.1'\n");

  const pluginPath = path.join(home, ".claude", "plugins", "cache", "openai-codex", "codex", "1.0.6");
  await mkdir(path.join(pluginPath, "agents"), { recursive: true });
  await mkdir(path.join(pluginPath, "scripts"), { recursive: true });
  await writeFile(path.join(pluginPath, "agents", "codex-rescue.md"), "# test agent\n");
  await writeFile(path.join(pluginPath, "scripts", "codex-companion.mjs"), `console.log(JSON.stringify({ready:true,node:{available:true},codex:{available:true},auth:{loggedIn:true,authMethod:"chatgpt"}}));\n`);

  const paths = setupPaths({ home, nodeBin: process.execPath, binaryOverrides: { claude: claudeBin, codex: codexBin, npm: npmBin, git: gitBin }, managedFiles: [] });
  await mkdir(path.dirname(paths.settingsFile), { recursive: true });
  await writeFile(paths.settingsFile, JSON.stringify({ enabledPlugins: { "codex@openai-codex": true }, customSetting: "keep-me" }));
  await writeFile(paths.marketplacesFile, JSON.stringify({ "openai-codex": { source: { source: "github", repo: "openai/codex-plugin-cc" } } }));
  await writeFile(paths.installedPluginsFile, JSON.stringify({ version: 2, plugins: { "codex@openai-codex": [{ scope: "user", installPath: pluginPath, version: "1.0.6" }] } }));
  await mkdir(path.dirname(paths.routingFile), { recursive: true });
  await writeFile(paths.routingFile, embedConfig(DEFAULT_CONFIG));
  await installTelemetry({ home, settingsFile: paths.settingsFile, nodePath: process.execPath });
  return { home, paths, overrides: { home, nodeBin: process.execPath, binaryOverrides: { claude: claudeBin, codex: codexBin, npm: npmBin, git: gitBin }, managedFiles: [] } };
}

test("zero-setup status verifies subscription auth, plugin, policy, telemetry, and token-free bridge check", async () => {
  const fixture = await createReadySetupFixture();
  const before = await getSetupStatus(fixture.overrides);
  assert.equal(before.runtime.ready, true);
  assert.equal(before.claude.auth.method, "claude-team");
  assert.equal(before.codex.auth.method, "chatgpt");
  assert.equal(before.codex.auth.subscriptionOnly, true);
  assert.equal(before.plugin.agentAvailable, true);
  assert.equal(before.bridge.ready, true);
  assert.equal(before.progress.ready, false);

  const checked = await runBridgeSelfCheck(fixture.overrides);
  assert.equal(checked.check.ready, true);
  assert.equal(checked.status.progress.ready, true);
  assert.equal(JSON.stringify(checked).includes("@"), false);
});

test("setup PATH merge preserves Claude settings and terminal auth scripts never use API keys", async () => {
  const fixture = await createReadySetupFixture();
  const merged = await ensureClaudeToolPath(fixture.overrides);
  assert.equal(merged.changed, true);
  const settings = JSON.parse(await readFile(fixture.paths.settingsFile, "utf8"));
  assert.equal(settings.customSetting, "keep-me");
  assert.equal(settings.enabledPlugins["codex@openai-codex"], true);
  assert.ok(settings.env.PATH.includes(path.dirname(fixture.overrides.binaryOverrides.codex)));

  let launchedPath = null;
  await launchSetupTerminalAction("auth-codex", { ...fixture.overrides, launcher(scriptPath) { launchedPath = scriptPath; return { launched: true, scriptPath }; } });
  const script = await readFile(launchedPath, "utf8");
  assert.match(script, /unset OPENAI_API_KEY OPENAI_BASE_URL/);
  assert.match(script, /login/);
  assert.doesNotMatch(script, /--with-api-key|sk-/);

  let codexInstallPath = null;
  await launchSetupTerminalAction("install-codex", { ...fixture.overrides, launcher(scriptPath) { codexInstallPath = scriptPath; return { launched: true, scriptPath }; } });
  const codexInstall = await readFile(codexInstallPath, "utf8");
  assert.match(codexInstall, /install --prefix/);
  assert.match(codexInstall, /\.claude-codex-router\/tools/);
  assert.doesNotMatch(codexInstall, /(^|\n)\s*sudo\b|OPENAI_API_KEY=/);
});
