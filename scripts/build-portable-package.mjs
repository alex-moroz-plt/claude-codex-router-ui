import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD_DIR = path.join(ROOT, "public", "downloads");
const ARCHIVE_PATH = path.join(DOWNLOAD_DIR, "Claude-Codex-Router-UI.zip");
const stage = await mkdtemp(path.join(tmpdir(), "claude-codex-router-package-"));
const packageDir = path.join(stage, "Claude-Codex-Router-UI");

try {
  await cp(ROOT, packageDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(ROOT, source);
      if (!relative) return true;
      if (relative === ".DS_Store" || relative.endsWith(`${path.sep}.DS_Store`)) return false;
      const topLevel = relative.split(path.sep)[0];
      if ([".git", ".idea", "node_modules"].includes(topLevel)) return false;
      if (relative.endsWith(".tgz")) return false;
      if (relative === "public/downloads" || relative.startsWith(`public/downloads${path.sep}`)) return false;
      return true;
    }
  });
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const result = spawnSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", packageDir, ARCHIVE_PATH], {
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr || "Could not build portable archive");
  const info = await stat(ARCHIVE_PATH);
  console.log(`${ARCHIVE_PATH} (${info.size} bytes)`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
