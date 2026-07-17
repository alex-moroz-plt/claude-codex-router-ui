import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cancelDelegatedTask,
  DEFAULT_CONFIG,
  embedConfig,
  extractConfig,
  generateRules,
  restoreLatest,
  retryDelegatedTask,
  saveConfig,
  validateConfig
} from "../server.mjs";
import { getUsageHistory, summarizeClaudeRecords, summarizeCodexRateLimits, summarizeCodexRecords } from "../usage-history.mjs";
import {
  findDelegatedTaskControl,
  getTelemetryStatus,
  installTelemetry,
  readDelegatedTasks,
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
  assert.match(rules, /touch 3 or more distinct files/);
  assert.match(rules, /Delegation is mandatory/);
  assert.match(rules, /does not count as Codex involvement/);
  assert.match(rules, /Do not wait for the user to ask for Codex/);
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
  const custom = { ...DEFAULT_CONFIG, fileThreshold: 7, implementationFileThreshold: 5, postReview: "off" };
  assert.deepEqual(extractConfig(embedConfig(custom)), custom);
});

test("legacy profiles migrate to Codex-forward implementation thresholds", () => {
  const { implementationFileThreshold: _removed, ...legacy } = DEFAULT_CONFIG;
  assert.equal(validateConfig({ ...legacy, version: 1, costProfile: "economy" }).implementationFileThreshold, 5);
  assert.equal(validateConfig({ ...legacy, version: 1, costProfile: "balanced" }).implementationFileThreshold, 3);
  assert.equal(validateConfig({ ...legacy, version: 1, costProfile: "strict" }).implementationFileThreshold, 2);
  assert.equal(validateConfig({ ...legacy, version: 1, costProfile: "strict" }).version, 2);
});

test("invalid or expensive audit values are rejected", () => {
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, normalAuditEffort: "xhigh" }), /medium or high/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, riskEffort: "xhigh" }), /riskEffort is invalid/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, smallModel: "gpt-5.4-mini" }), /GPT-5.6 model/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, claudeModel: "custom-model" }), /not supported/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, packetTokens: 99999 }), /packetTokens/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, implementationFileThreshold: 1 }), /implementationFileThreshold/);
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
  assert.match(html, /id="implementationFileThreshold"/);
  assert.match(html, /Automatic gate/);
  assert.match(html, /Контекст plan-audit/);
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

test("Codex rate-limit snapshots preserve dynamic 5-hour and weekly windows", () => {
  const fiveHourReset = Math.floor(Date.parse("2026-07-17T15:00:00Z") / 1000);
  const weeklyReset = Math.floor(Date.parse("2026-07-20T00:00:00Z") / 1000);
  const snapshot = summarizeCodexRateLimits([
    {
      type: "event_msg",
      timestamp: "2026-07-17T09:00:00Z",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: 99, window_minutes: 300 } } }
    },
    {
      type: "event_msg",
      timestamp: "2026-07-17T10:00:00Z",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          plan_type: "plus",
          primary: { used_percent: 42.5, window_minutes: 300, resets_at: fiveHourReset },
          secondary: { used_percent: 18, window_minutes: 10_080, resets_at: weeklyReset }
        }
      }
    }
  ]);
  assert.deepEqual(snapshot, {
    limitId: "codex",
    limitName: null,
    planType: "plus",
    observedAt: "2026-07-17T10:00:00.000Z",
    windows: [
      { usedPercent: 42.5, remainingPercent: 57.5, windowMinutes: 300, resetsAt: "2026-07-17T15:00:00.000Z" },
      { usedPercent: 18, remainingPercent: 82, windowMinutes: 10_080, resetsAt: "2026-07-20T00:00:00.000Z" }
    ]
  });
});

test("usage history applies an exact date range before calculating displayed totals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "router-usage-range-"));
  const claudeRoot = path.join(root, "claude");
  const codexRoot = path.join(root, "codex");
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(codexRoot, { recursive: true });
  await writeFile(path.join(claudeRoot, "today.jsonl"), `${JSON.stringify({
    sessionId: "today",
    cwd: "/tmp/today",
    timestamp: "2026-07-17T08:00:00Z",
    message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 } }
  })}\n`);
  await writeFile(path.join(codexRoot, "yesterday.jsonl"), [
    { type: "session_meta", timestamp: "2026-07-16T08:00:00Z", payload: { id: "yesterday", cwd: "/tmp/yesterday" } },
    {
      type: "event_msg",
      timestamp: "2026-07-16T08:01:00Z",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } },
        rate_limits: {
          limit_id: "codex",
          plan_type: "plus",
          primary: { used_percent: 37, window_minutes: 300, resets_at: Math.floor(Date.parse("2026-07-18T08:00:00Z") / 1000) }
        }
      }
    }
  ].map(JSON.stringify).join("\n"));

  const history = await getUsageHistory({
    limit: 20,
    from: "2026-07-17T00:00:00Z",
    to: "2026-07-18T00:00:00Z",
    claudeRoot,
    codexRoot
  });
  assert.deepEqual(history.items.map((item) => item.id), ["claude:today"]);
  assert.deepEqual(history.totals, { claude: { sessions: 1, tokens: 15 }, codex: { sessions: 0, tokens: 0 } });
  assert.equal(history.codexLimits.windows[0].usedPercent, 37);
  assert.equal(history.codexLimits.windows[0].windowMinutes, 300);
});

test("live delegated tasks use companion job state and flag dead worker processes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "router-live-jobs-"));
  const stateFile = path.join(root, "state.json");
  await writeFile(stateFile, JSON.stringify({
    jobs: [
      {
        id: "task-running",
        status: "running",
        jobClass: "task",
        title: "Codex Task",
        summary: "ROUTER_MODE: audit ROUTER_CLASS: normal ROUTER_MODEL: gpt-5.6-sol ROUTER_EFFORT: high PRIVATE PROMPT",
        workspaceRoot: "/tmp/demo",
        pid: 111,
        startedAt: "2026-07-17T09:59:00Z",
        updatedAt: "2026-07-17T09:59:30Z"
      },
      {
        id: "task-stale",
        status: "running",
        jobClass: "task",
        summary: "ROUTER_MODE: implementation ROUTER_MODEL: gpt-5.6-terra PRIVATE CODE",
        workspaceRoot: "/tmp/demo",
        pid: 222,
        threadId: "thread-stale",
        startedAt: "2026-07-17T09:50:00Z",
        updatedAt: "2026-07-17T09:50:30Z"
      },
      { id: "task-done", status: "completed", jobClass: "task", updatedAt: "2026-07-17T09:58:00Z" }
    ]
  }));

  const live = await readDelegatedTasks({
    stateFiles: [stateFile],
    pidChecker: (pid) => pid === 111,
    now: Date.parse("2026-07-17T10:00:00Z")
  });
  assert.deepEqual(live.counts, { queued: 0, running: 1, stalled: 1 });
  assert.equal(live.items.find((item) => item.id === "task-running").route, "audit");
  assert.equal(live.items.find((item) => item.id === "task-running").canCancel, true);
  assert.equal(live.items.find((item) => item.id === "task-stale").status, "stalled");
  assert.equal(live.items.find((item) => item.id === "task-stale").canRetry, true);
  assert.equal(live.items.find((item) => item.id === "task-stale").retryMode, "resume");
  assert.doesNotMatch(JSON.stringify(live), /PRIVATE|PROMPT|CODE/);
});

test("delegated task control resolves the owning companion data directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "router-live-control-"));
  const pluginDataDir = path.join(root, "codex-inline");
  const stateFile = path.join(pluginDataDir, "state", "demo-123", "state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ jobs: [{
    id: "task-stale-control",
    status: "running",
    jobClass: "task",
    workspaceRoot: "/tmp/demo",
    updatedAt: "2026-07-17T10:00:00Z"
  }] }));
  const jobFile = path.join(path.dirname(stateFile), "jobs", "task-stale-control.json");
  await mkdir(path.dirname(jobFile), { recursive: true });
  await writeFile(jobFile, JSON.stringify({ request: { prompt: "private" } }));
  const control = await findDelegatedTaskControl("task-stale-control", {
    pluginDataRoot: root,
    fallbackStateRoot: path.join(root, "missing"),
    now: Date.parse("2026-07-17T10:01:00Z"),
    pidChecker: () => false
  });
  assert.deepEqual(control, {
    id: "task-stale-control",
    status: "running",
    stalled: true,
    canRetry: true,
    retryMode: "replay",
    workspaceRoot: "/tmp/demo",
    pluginDataDir,
    sessionId: null,
    threadId: null,
    model: null,
    effort: null,
    write: false
  });
});

test("stale cleanup delegates to the official companion cancel command", async () => {
  let invocation = null;
  const result = await cancelDelegatedTask("task-stale-control", {
    findTask: async () => ({
      id: "task-stale-control",
      status: "running",
      workspaceRoot: "/tmp/demo",
      pluginDataDir: "/tmp/plugin-data"
    }),
    getStatus: async () => ({ plugin: { companionAvailable: true, companionPath: "/tmp/codex-companion.mjs" } }),
    nodePath: "/tmp/node",
    run: async (...args) => {
      invocation = args;
      return { code: 0, stdout: JSON.stringify({ jobId: "task-stale-control", status: "cancelled" }), stderr: "" };
    }
  });
  assert.deepEqual(result, { taskId: "task-stale-control", status: "cancelled" });
  assert.deepEqual(invocation[1], [
    "/tmp/codex-companion.mjs", "cancel", "task-stale-control", "--json", "--cwd", "/tmp/demo"
  ]);
  assert.equal(invocation[2].env.CLAUDE_PLUGIN_DATA, "/tmp/plugin-data");
  assert.equal(invocation[2].cwd, "/tmp/demo");
});

test("stale retry cancels first and replays the saved request through the companion worker", async () => {
  const invocations = [];
  let launch = null;
  const result = await retryDelegatedTask("task-stale-control", {
    findTask: async () => ({
      id: "task-stale-control",
      status: "running",
      stalled: true,
      canRetry: true,
      retryMode: "replay",
      workspaceRoot: "/tmp/demo",
      pluginDataDir: "/tmp/plugin-data"
    }),
    getStatus: async () => ({ plugin: { companionAvailable: true, companionPath: "/tmp/codex-companion.mjs" } }),
    nodePath: "/tmp/node",
    run: async (...args) => {
      invocations.push(args);
      return { code: 0, stdout: JSON.stringify({ status: "cancelled" }), stderr: "" };
    },
    launch: async (...args) => {
      launch = args;
      return { pid: 4321 };
    }
  });
  assert.deepEqual(result, { taskId: "task-stale-control", status: "retrying", pid: 4321, retryMode: "replay" });
  assert.deepEqual(invocations[0][1], [
    "/tmp/codex-companion.mjs", "cancel", "task-stale-control", "--json", "--cwd", "/tmp/demo"
  ]);
  assert.deepEqual(launch[1], [
    "/tmp/codex-companion.mjs", "task-worker", "--cwd", "/tmp/demo", "--job-id", "task-stale-control"
  ]);
  assert.equal(launch[2].env.CLAUDE_PLUGIN_DATA, "/tmp/plugin-data");
});

test("stale retry resumes the exact saved thread when a foreground job has no request payload", async () => {
  const invocations = [];
  const result = await retryDelegatedTask("task-stale-thread", {
    findTask: async () => ({
      id: "task-stale-thread",
      status: "running",
      stalled: true,
      canRetry: true,
      retryMode: "resume",
      workspaceRoot: "/tmp/demo",
      pluginDataDir: "/tmp/plugin-data",
      sessionId: "session-123",
      threadId: "thread-123",
      model: "gpt-5.6-sol",
      effort: "high",
      write: true
    }),
    getStatus: async () => ({ plugin: { companionAvailable: true, companionPath: "/tmp/codex-companion.mjs" } }),
    nodePath: "/tmp/node",
    run: async (...args) => {
      invocations.push(args);
      return invocations.length === 1
        ? { code: 0, stdout: JSON.stringify({ status: "cancelled" }), stderr: "" }
        : { code: 0, stdout: JSON.stringify({ jobId: "task-retried", status: "queued" }), stderr: "" };
    }
  });
  assert.deepEqual(result, {
    taskId: "task-retried",
    sourceTaskId: "task-stale-thread",
    status: "queued",
    retryMode: "resume"
  });
  assert.deepEqual(invocations[1][1], [
    "/tmp/codex-companion.mjs", "task", "--background", "--resume", "--json", "--cwd", "/tmp/demo",
    "--model", "gpt-5.6-sol", "--effort", "high", "--write"
  ]);
  assert.equal(invocations[1][2].env.CODEX_COMPANION_SESSION_ID, "session-123");
});

test("retry rejects live workers and stale records without a saved request", async () => {
  await assert.rejects(
    retryDelegatedTask("task-live-control", {
      findTask: async () => ({ id: "task-live-control", stalled: false, canRetry: true })
    }),
    /Only a stale delegated task can be retried/
  );
  await assert.rejects(
    retryDelegatedTask("task-old-control", {
      findTask: async () => ({ id: "task-old-control", stalled: true, canRetry: false })
    }),
    /original task request is unavailable/
  );
});

test("history page exposes live polling and every requested date filter", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const [html, app, server] = await Promise.all([
    readFile(path.join(root, "public", "index.html"), "utf8"),
    readFile(path.join(root, "public", "app.js"), "utf8"),
    readFile(path.join(root, "server.mjs"), "utf8")
  ]);
  for (const period of ["today", "yesterday", "week", "month", "custom"]) {
    assert.match(html, new RegExp(`data-history-period="${period}"`));
  }
  assert.match(html, /id="delegatedLiveRows"/);
  assert.match(html, /id="codexLimitWindows"/);
  assert.match(html, /Reinstall logger &amp; gate/);
  assert.match(html, /Disable logger &amp; gate/);
  assert.doesNotMatch(html, /Export installer/);
  assert.match(app, /\/api\/delegated-tasks/);
  assert.match(app, /function renderCodexLimits/);
  assert.match(app, /windowMinutes/);
  assert.match(app, /repair\.hidden = status\.state !== "needs-repair"/);
  assert.match(app, /Copy ID/);
  assert.match(app, /Retry/);
  assert.match(app, /Clear stale/);
  assert.match(app, /setInterval[\s\S]+3_000/);
  assert.match(server, /url\.pathname === "\/api\/delegated-tasks"/);
  assert.match(server, /url\.pathname === "\/api\/delegated-tasks\/cancel"/);
});

test("routing decision totals respect the selected history date range", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "router-routing-range-"));
  const eventsFile = path.join(root, "events.jsonl");
  await writeFile(eventsFile, [
    { eventType: "decision", route: "delegated", timestamp: "2026-07-16T18:00:00Z", decisionId: "old" },
    { eventType: "decision", route: "audit", timestamp: "2026-07-17T09:00:00Z", decisionId: "today" },
    { eventType: "outcome", route: "audit", timestamp: "2026-07-17T09:05:00Z", decisionId: "today", outcome: "completed", verdict: "APPROVE" }
  ].map(JSON.stringify).join("\n"));
  const routing = await readRoutingTelemetry({
    eventsFile,
    from: "2026-07-17T00:00:00Z",
    to: "2026-07-18T00:00:00Z"
  });
  assert.deepEqual(routing.totals, { "claude-only": 0, delegated: 0, audit: 1 });
  assert.equal(routing.items[0].verdict, "APPROVE");
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
      env: { ...process.env, ROUTER_HISTORY_DIR: historyDir, CLAUDE_ROUTING_FILE: path.join(historyDir, "agent-routing.md") },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `logger exited ${code}`)));
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
  assert.ok(afterInstall.hooks.InstructionsLoaded);
  assert.ok(afterInstall.hooks.PreToolUse.some((group) => group.matcher === "Agent|Task|Edit|Write|NotebookEdit"));

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
  const reminderOutput = await runLogger(paths.loggerFile, paths.historyDir, { ...common, hook_event_name: "UserPromptSubmit", prompt: "SECRET USER PROMPT" });
  const reminder = JSON.parse(reminderOutput).hookSpecificOutput.additionalContext;
  assert.match(reminder, /3\+ files/);
  assert.match(reminder, /4\+ files/);
  assert.doesNotMatch(reminder, /SECRET|USER PROMPT/);
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

  const implementation = { session_id: "claude-implementation-session", cwd: "/tmp/private-project" };
  await runLogger(paths.loggerFile, paths.historyDir, { ...implementation, hook_event_name: "UserPromptSubmit", prompt: "PRIVATE IMPLEMENTATION" });
  await runLogger(paths.loggerFile, paths.historyDir, {
    ...implementation,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue",
      prompt: "ROUTER_MODE: implementation\nROUTER_CLASS: multi-file\nROUTER_MODEL: gpt-5.6-terra\nROUTER_EFFORT: high\nPRIVATE CODE"
    }
  });
  await runLogger(paths.loggerFile, paths.historyDir, {
    ...implementation,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "codex:codex-rescue" },
    tool_response: { status: "BLOCK", content: "Implementation completed" }
  });
  await runLogger(paths.loggerFile, paths.historyDir, { ...implementation, hook_event_name: "Stop" });

  const claudeOnly = { session_id: "claude-only-session", cwd: "/tmp/second-project" };
  await runLogger(paths.loggerFile, paths.historyDir, { ...claudeOnly, hook_event_name: "UserPromptSubmit", prompt: "ANOTHER SECRET" });
  await runLogger(paths.loggerFile, paths.historyDir, { ...claudeOnly, hook_event_name: "Stop" });

  const routing = await readRoutingTelemetry({ ...overrides, limit: 20 });
  assert.deepEqual(routing.totals, { "claude-only": 1, delegated: 1, audit: 1 });
  const audit = routing.items.find((item) => item.route === "audit");
  assert.equal(audit.model, "gpt-5.6-sol");
  assert.equal(audit.effort, "high");
  assert.equal(audit.verdict, "APPROVE");
  const delegated = routing.items.find((item) => item.route === "delegated");
  assert.equal(delegated.outcome, "completed");
  assert.equal(delegated.verdict, null);
  const rawLog = await readFile(paths.eventsFile, "utf8");
  assert.doesNotMatch(rawLog, /SECRET|USER PROMPT|REVIEW/);
  assert.equal((await getTelemetryStatus(overrides)).state, "active");

  await runLogger(paths.loggerFile, paths.historyDir, {
    session_id: "instructions-session",
    hook_event_name: "InstructionsLoaded",
    file_path: path.join(home, ".claude", "rules", "agent-routing.md")
  });
  assert.ok((await getTelemetryStatus(overrides)).policyLoadedAt);
});

test("routing gate blocks the threshold-reaching edit once and permits an explicit retry", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "router-threshold-gate-"));
  const overrides = { home, nodePath: process.execPath };
  const paths = telemetryPaths(overrides);
  await installTelemetry(overrides);
  const common = { session_id: "claude-edit-session", cwd: "/tmp/private-project" };
  await runLogger(paths.loggerFile, paths.historyDir, { ...common, hook_event_name: "UserPromptSubmit", prompt: "PRIVATE MULTI FILE TASK" });
  const edit = (filePath) => runLogger(paths.loggerFile, paths.historyDir, {
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "PRIVATE", new_string: "PRIVATE" }
  });
  assert.equal(await edit("src/one.ts"), "");
  assert.equal(await edit("src/two.ts"), "");
  const blocked = JSON.parse(await edit("src/three.ts")).hookSpecificOutput;
  assert.equal(blocked.permissionDecision, "deny");
  assert.match(blocked.permissionDecisionReason, /3 distinct edited files/);
  assert.doesNotMatch(blocked.permissionDecisionReason, /PRIVATE MULTI FILE TASK/);
  assert.equal(await edit("src/three.ts"), "");
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
