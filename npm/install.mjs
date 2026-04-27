#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_REPO = "ultracontext/ultracontext";
export const DEFAULT_MUTAGEN_VERSION = "v0.18.1";

export function ultracontextTarget(platform = process.platform, arch = process.arch) {
  const table = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "linux:x64": "x86_64-unknown-linux-gnu"
  };
  const target = table[`${platform}:${arch}`];
  if (!target) {
    throw new Error(`unsupported platform: ${platform}/${arch}`);
  }
  return target;
}

export function ultracontextAsset(target = ultracontextTarget()) {
  return `ultracontext-${target}.tar.gz`;
}

export function mutagenAsset(platform = process.platform, arch = process.arch, version = DEFAULT_MUTAGEN_VERSION) {
  const table = {
    "darwin:arm64": "mutagen_darwin_arm64",
    "darwin:x64": "mutagen_darwin_amd64",
    "linux:arm64": "mutagen_linux_arm64",
    "linux:x64": "mutagen_linux_amd64"
  };
  const prefix = table[`${platform}:${arch}`];
  if (!prefix) {
    throw new Error(`unsupported Mutagen platform: ${platform}/${arch}`);
  }
  return `${prefix}_${version}.tar.gz`;
}

export function normalizeTag(version) {
  if (version === "latest" || version.startsWith("v")) {
    return version;
  }
  return `v${version}`;
}

export function releaseUrl({ repo = DEFAULT_REPO, tag, asset, downloadBase }) {
  if (downloadBase) {
    return `${downloadBase.replace(/\/$/, "")}/${asset}`;
  }
  if (tag === "latest") {
    return `https://github.com/${repo}/releases/latest/download/${asset}`;
  }
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

async function download(url, destination, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`too many redirects while downloading ${url}`);
  }

  await new Promise((resolvePromise, rejectPromise) => {
    https.get(url, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination, redirects + 1).then(resolvePromise, rejectPromise);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        rejectPromise(new Error(`download failed (${response.statusCode}): ${url}`));
        return;
      }
      pipeline(response, createWriteStream(destination)).then(resolvePromise, rejectPromise);
    }).on("error", rejectPromise);
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function commandExists(command) {
  const result = spawnSync("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], {
    stdio: "ignore"
  });
  return result.status === 0;
}

function pathCommands(command) {
  const result = spawnSync("sh", ["-c", `which -a ${command} 2>/dev/null || true`], {
    encoding: "utf8"
  });
  if (result.status !== 0 && result.status !== null) {
    return [];
  }
  return [...new Set(result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}

function findOtherInstalls(nativeDir) {
  const normalizedNativeDir = nativeDir.replace(/\\/g, "/");
  return [...new Set([...pathCommands("uc"), ...pathCommands("ultracontext")])]
    .filter(path => !path.replace(/\\/g, "/").startsWith(normalizedNativeDir));
}

function warnAboutOtherInstalls(nativeDir) {
  const others = findOtherInstalls(nativeDir);
  if (others.length === 0) return;

  console.error("");
  console.error("Warning: another UltraContext install is already on PATH:");
  for (const other of others) {
    console.error(`  ${other}`);
  }
  console.error("This npm install completed, but your shell may use whichever uc appears first in PATH.");
  console.error("Run: which -a uc ultracontext");
}

async function findFile(root, name) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, name);
      if (nested) {
        return nested;
      }
    } else if (entry.isFile() && entry.name === name) {
      return candidate;
    }
  }
  return null;
}

async function extractTarGz(archive, destination) {
  await mkdir(destination, { recursive: true });
  run("tar", ["-xzf", archive, "-C", destination]);
}

async function installArchiveBinary({ url, binaryName, destination, workDir }) {
  const archive = join(workDir, url.split("/").pop() || "download.tar.gz");
  const extractDir = join(workDir, binaryName);
  console.error(`Downloading ${binaryName}: ${url}`);
  await download(url, archive);
  await extractTarGz(archive, extractDir);
  const binary = await findFile(extractDir, binaryName);
  if (!binary) {
    throw new Error(`could not find ${binaryName} in downloaded archive`);
  }
  await copyFile(binary, destination);
  await chmod(destination, 0o755);
  return extractDir;
}

// Walk extractDir for any */skills/ultracontext/SKILL.md and return that dir.
async function findSkillDir(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (entry.name === "skills") {
      const sub = join(candidate, "ultracontext");
      if (existsSync(join(sub, "SKILL.md"))) return sub;
    }
    const nested = await findSkillDir(candidate);
    if (nested) return nested;
  }
  return null;
}

// Copy bundled skill into every supported agent-skills discovery path.
async function installSkill(extractDir) {
  if (process.env.ULTRACONTEXT_INSTALL_SKILL === "0") return;
  if (!extractDir) return;

  const srcDir = await findSkillDir(extractDir);
  if (!srcDir) {
    console.error("Skill bundle not found in release; skipping skill install.");
    return;
  }

  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return;
  const defaults = `${home}/.claude/skills ${home}/.agents/skills ${home}/.openclaw/skills`;
  const targets = (process.env.ULTRACONTEXT_SKILL_TARGETS || defaults)
    .split(/\s+/)
    .filter(Boolean);

  for (const base of targets) {
    const dst = join(base, "ultracontext");
    await mkdir(base, { recursive: true });
    await rm(dst, { recursive: true, force: true });
    await cp(srcDir, dst, { recursive: true });
    console.error(`Installed UltraContext skill to ${dst}`);
  }
}

async function installFromOverride({ envName, destination }) {
  const source = process.env[envName];
  if (!source) {
    return false;
  }
  await copyFile(source, destination);
  await chmod(destination, 0o755);
  return true;
}

// Re-verify everything we just installed and print a single status block.
function printSummary({ ultracontextDestination, mutagenDestination, skillTargets }) {
  let failed = false;
  const line = (state, label, detail) => {
    const marker = { ok: "[ok]  ", miss: "[!!]  ", skip: "[--]  ", warn: "[!]   " }[state];
    if (state === "miss") failed = true;
    console.error(`  ${marker}${label.padEnd(13)} ${detail}`);
  };

  console.error("");
  console.error("UltraContext install summary:");

  if (existsSync(ultracontextDestination)) line("ok", "ultracontext", ultracontextDestination);
  else line("miss", "ultracontext", `${ultracontextDestination} (missing)`);

  if (process.env.ULTRACONTEXT_INSTALL_MUTAGEN === "0") {
    line("skip", "mutagen", "skipped (ULTRACONTEXT_INSTALL_MUTAGEN=0)");
  } else if (commandExists("mutagen")) {
    line("ok", "mutagen", "on PATH");
  } else if (existsSync(mutagenDestination)) {
    line("ok", "mutagen", mutagenDestination);
  } else {
    line("miss", "mutagen", "missing");
  }

  if (process.env.ULTRACONTEXT_INSTALL_SKILL === "0") {
    line("skip", "skill", "skipped (ULTRACONTEXT_INSTALL_SKILL=0)");
  } else {
    let count = 0;
    for (const base of skillTargets) {
      const dst = join(base, "ultracontext");
      if (existsSync(join(dst, "SKILL.md"))) {
        line("ok", "skill", dst);
        count += 1;
      }
    }
    if (count === 0) {
      line("warn", "skill", "not installed (skill bundle missing from release)");
    }
  }

  console.error("");
  console.error(failed ? "Install completed with errors above." : "Install OK. Run: uc setup");
}

async function main() {
  if (process.env.ULTRACONTEXT_SKIP_DOWNLOAD === "1") {
    console.error("Skipping UltraContext native binary download.");
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, "..");
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const nativeDir = process.env.ULTRACONTEXT_NATIVE_DIR || join(packageRoot, "npm", "native");
  const workDir = join(nativeDir, ".tmp");
  const binaryName = process.platform === "win32" ? "ultracontext.exe" : "ultracontext";
  const ultracontextDestination = join(nativeDir, binaryName);
  const mutagenDestination = join(nativeDir, process.platform === "win32" ? "mutagen.exe" : "mutagen");

  await mkdir(nativeDir, { recursive: true });
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    if (existsSync(ultracontextDestination)) {
      console.error("Updating UltraContext");
      console.error(`  current: ${packageJson.version}`);
      console.error(`  target:  ${process.env.ULTRACONTEXT_VERSION || packageJson.version}`);
    } else {
      console.error("Installing UltraContext");
      console.error(`  target: ${process.env.ULTRACONTEXT_VERSION || packageJson.version}`);
    }

    const copiedUltracontext = await installFromOverride({
      envName: "ULTRACONTEXT_BINARY",
      destination: ultracontextDestination
    });
    let installedSkill = false;
    if (!copiedUltracontext && !existsSync(ultracontextDestination)) {
      const tag = normalizeTag(process.env.ULTRACONTEXT_VERSION || packageJson.version);
      const asset = ultracontextAsset();
      const url = releaseUrl({
        repo: process.env.ULTRACONTEXT_REPO || DEFAULT_REPO,
        tag,
        asset,
        downloadBase: process.env.ULTRACONTEXT_DOWNLOAD_BASE
      });
      const extractDir = await installArchiveBinary({
        url,
        binaryName,
        destination: ultracontextDestination,
        workDir
      });
      await installSkill(extractDir);
      installedSkill = true;
    }
    if (!installedSkill) {
      await installSkill(packageRoot);
    }

    if (process.env.ULTRACONTEXT_INSTALL_MUTAGEN !== "0" && !commandExists("mutagen") && !existsSync(mutagenDestination)) {
      const copiedMutagen = await installFromOverride({
        envName: "ULTRACONTEXT_MUTAGEN_BINARY",
        destination: mutagenDestination
      });
      if (!copiedMutagen) {
        const version = process.env.ULTRACONTEXT_MUTAGEN_VERSION || DEFAULT_MUTAGEN_VERSION;
        const asset = mutagenAsset(process.platform, process.arch, version);
        const url = `https://github.com/mutagen-io/mutagen/releases/download/${version}/${asset}`;
        await installArchiveBinary({
          url,
          binaryName: process.platform === "win32" ? "mutagen.exe" : "mutagen",
          destination: mutagenDestination,
          workDir
        });
      }
    }

    const home = process.env.HOME || process.env.USERPROFILE || "";
    const skillTargets = (process.env.ULTRACONTEXT_SKILL_TARGETS || `${home}/.claude/skills ${home}/.agents/skills ${home}/.openclaw/skills`)
      .split(/\s+/)
      .filter(Boolean);
    printSummary({ ultracontextDestination, mutagenDestination, skillTargets });
    warnAboutOtherInstalls(nativeDir);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
