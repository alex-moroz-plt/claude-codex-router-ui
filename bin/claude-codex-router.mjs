#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSetupStatus } from "../setup-manager.mjs";
import { startServer } from "../server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 4177;
const URL = `http://${HOST}:${PORT}`;
const LABEL = "com.local.claude-codex-router-ui";
const PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(homedir(), "Library", "Logs");
const OUT_LOG = path.join(LOG_DIR, "ClaudeCodexRouterUI.log");
const ERR_LOG = path.join(LOG_DIR, "ClaudeCodexRouterUI.error.log");

function usage() {
  return `Claude × Codex Router

Usage:
  claude-codex-router start [--no-open]   Start the local UI server in the foreground
  claude-codex-router install             Start the local UI now without installing a login service
  claude-codex-router open                Start the local UI if needed, then open it in your browser
  claude-codex-router service install     Install/repair the macOS service without start-at-login
  claude-codex-router service install --start-at-login
                                           Install the service with RunAtLoad and KeepAlive
  claude-codex-router service uninstall   Remove only the macOS background service
  claude-codex-router uninstall           Alias for service uninstall
  claude-codex-router doctor              Print local setup status
  claude-codex-router build-portable      Build public/downloads/Claude-Codex-Router-UI.zip
  claude-codex-router help                Show this help
`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout;
}

async function healthCheck(timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${URL}/api/health`);
      if (response.ok) return true;
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function buildPortable() {
  const script = path.join(ROOT, "scripts", "build-portable-package.mjs");
  if (!existsSync(script)) throw new Error(`Missing build script: ${script}`);
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Portable archive build failed");
  process.stdout.write(result.stdout);
}

async function writeLaunchAgent({ startAtLogin = false } = {}) {
  if (process.platform !== "darwin") {
    throw new Error("Background service installation is currently supported on macOS only.");
  }
  await mkdir(path.dirname(PLIST), { recursive: true, mode: 0o700 });
  await mkdir(LOG_DIR, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(path.join(ROOT, "server.mjs"))}</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(ROOT)}</string>
${startAtLogin ? "  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n" : ""}  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(OUT_LOG)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(ERR_LOG)}</string>
</dict>
</plist>
`;
  await writeFile(PLIST, plist, { encoding: "utf8", mode: 0o600 });
  run("/usr/bin/plutil", ["-lint", PLIST]);
}

async function ensureOnDemandServer() {
  if (await healthCheck(500)) return;
  await mkdir(LOG_DIR, { recursive: true });
  const out = openSync(OUT_LOG, "a");
  const err = openSync(ERR_LOG, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs"), "--no-open"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, err]
  });
  closeSync(out);
  closeSync(err);
  child.unref();
  if (!(await healthCheck())) {
    throw new Error(`Router did not start. Check ${ERR_LOG}. Another app may already use port ${PORT}.`);
  }
}

async function bootService() {
  spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" });
  run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, PLIST]);
  run("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`]);
  if (!(await healthCheck())) {
    throw new Error(`Router service did not start. Check ${ERR_LOG}. Another app may already use port ${PORT}.`);
  }
}

async function uninstallService() {
  if (process.platform !== "darwin") throw new Error("Background service uninstall is currently supported on macOS only.");
  spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" });
  await rm(PLIST, { force: true });
  console.log("Background service removed. Routing config and backups were kept.");
}

async function openUi() {
  if (process.platform === "darwin") {
    const child = spawn("/usr/bin/open", [URL], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  console.log(URL);
}

async function doctor() {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const status = await getSetupStatus();
  const archive = path.join(ROOT, "public", "downloads", "Claude-Codex-Router-UI.zip");
  const archiveInfo = await stat(archive).catch(() => null);
  console.log(JSON.stringify({
    package: `${packageJson.name}@${packageJson.version}`,
    server: { url: URL, running: await healthCheck(500) },
    macosService: {
      plist: PLIST,
      installed: existsSync(PLIST),
      startAtLogin: existsSync(PLIST) ? (await readFile(PLIST, "utf8")).includes("<key>RunAtLoad</key>") : false,
      keepAlive: existsSync(PLIST) ? (await readFile(PLIST, "utf8")).includes("<key>KeepAlive</key>") : false
    },
    portableArchive: { path: archive, bytes: archiveInfo?.size || 0, present: Boolean(archiveInfo) },
    setup: {
      ready: status.progress.ready,
      progress: status.progress,
      claude: status.claude.auth.state,
      codex: status.codex.auth.state,
      subscriptionOnly: status.codex.auth.subscriptionOnly,
      plugin: status.plugin.installed && status.plugin.enabled,
      routingInstalled: status.configuration.routingInstalled,
      telemetry: status.configuration.telemetryState
    }
  }, null, 2));
}

async function main() {
  const command = process.argv[2] || "help";
  if (command === "start") {
    await startServer({ port: PORT, openBrowser: !process.argv.includes("--no-open") });
  } else if (command === "install") {
    await ensureOnDemandServer();
    await openUi();
    console.log(`Claude × Codex Router is running at ${URL}`);
    console.log("No LaunchAgent was installed. Use `claude-codex-router service install --start-at-login` only if you explicitly want login persistence.");
  } else if (command === "service") {
    const serviceCommand = process.argv[3] || "help";
    if (serviceCommand === "install") {
      const startAtLogin = process.argv.includes("--start-at-login");
      await writeLaunchAgent({ startAtLogin });
      await bootService();
      await openUi();
      console.log(`Background service installed at ${PLIST}`);
      console.log(startAtLogin
        ? "Start-at-login is enabled with RunAtLoad and KeepAlive."
        : "Start-at-login is disabled. RunAtLoad and KeepAlive were not written.");
    } else if (serviceCommand === "uninstall") {
      await uninstallService();
    } else {
      process.stderr.write(`Unknown service command: ${serviceCommand}\n\n${usage()}`);
      process.exitCode = 1;
    }
  } else if (command === "uninstall") {
    await uninstallService();
  } else if (command === "open") {
    await ensureOnDemandServer();
    await openUi();
  } else if (command === "doctor") {
    await doctor();
  } else if (command === "build-portable") {
    await buildPortable();
  } else if (["help", "-h", "--help"].includes(command)) {
    process.stdout.write(usage());
  } else if (["version", "-v", "--version"].includes(command)) {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    console.log(packageJson.version);
  } else {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
