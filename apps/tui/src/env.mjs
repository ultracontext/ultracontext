import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const ROOT_ENV_PATH = path.join(REPO_ROOT, ".env");
const APP_ENV_PATH = path.join(APP_ROOT, ".env");
const DAEMON_ENV_PATH = path.join(REPO_ROOT, "apps", "daemon", ".env");

function loadEnv() {
  const explicitPath = String(process.env.DOTENV_CONFIG_PATH ?? "").trim();
  if (explicitPath) {
    dotenv.config({ path: explicitPath, override: true });
    return;
  }

  const rootResult = dotenv.config({ path: ROOT_ENV_PATH, override: true });
  if (!rootResult.error) return;

  const appResult = dotenv.config({ path: APP_ENV_PATH, override: true });
  if (!appResult.error) return;

  dotenv.config({ path: DAEMON_ENV_PATH, override: true });
}

loadEnv();
