// Manage OS-level auto-start for the UltraContext daemon
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";

const HOME = process.env.HOME || process.env.USERPROFILE || "~";

// ── macOS LaunchAgent ──────────────────────────────────────────

const PLIST_DIR = path.join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = path.join(PLIST_DIR, "ai.ultracontext.daemon.plist");

const PLIST_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ultracontext.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>ultracontext</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${path.join(HOME, ".ultracontext", "launchd.stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(HOME, ".ultracontext", "launchd.stderr.log")}</string>
</dict>
</plist>
`;

function enableMacOS() {
  fs.mkdirSync(PLIST_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, PLIST_CONTENT, "utf8");
}

function disableMacOS() {
  try { fs.unlinkSync(PLIST_PATH); } catch { /* already gone */ }
}

function isEnabledMacOS() {
  return fs.existsSync(PLIST_PATH);
}

// ── Linux systemd user service ─────────────────────────────────

const SYSTEMD_DIR = path.join(HOME, ".config", "systemd", "user");
const SERVICE_PATH = path.join(SYSTEMD_DIR, "ultracontext.service");

const SERVICE_CONTENT = `[Unit]
Description=UltraContext Daemon
After=network.target

[Service]
Type=oneshot
ExecStart=ultracontext start
RemainAfterExit=no

[Install]
WantedBy=default.target
`;

function enableLinux() {
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  fs.writeFileSync(SERVICE_PATH, SERVICE_CONTENT, "utf8");
  try { execSync("systemctl --user daemon-reload && systemctl --user enable ultracontext.service", { stdio: "ignore" }); } catch { /* best effort */ }
}

function disableLinux() {
  try { execSync("systemctl --user disable ultracontext.service", { stdio: "ignore" }); } catch { /* best effort */ }
  try { fs.unlinkSync(SERVICE_PATH); } catch { /* already gone */ }
  try { execSync("systemctl --user daemon-reload", { stdio: "ignore" }); } catch { /* best effort */ }
}

function isEnabledLinux() {
  return fs.existsSync(SERVICE_PATH);
}

// ── platform dispatch ──────────────────────────────────────────

export function enableStartupItem() {
  if (process.platform === "darwin") return enableMacOS();
  if (process.platform === "linux") return enableLinux();
  throw new Error(`Start on startup not supported on ${process.platform}. Only macOS and Linux are supported.`);
}

export function disableStartupItem() {
  if (process.platform === "darwin") return disableMacOS();
  if (process.platform === "linux") return disableLinux();
  throw new Error(`Start on startup not supported on ${process.platform}. Only macOS and Linux are supported.`);
}

export function isStartupItemEnabled() {
  if (process.platform === "darwin") return isEnabledMacOS();
  if (process.platform === "linux") return isEnabledLinux();
  return false;
}
