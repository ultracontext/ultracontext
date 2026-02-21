import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const ROOT_ENV_PATH = path.join(REPO_ROOT, ".env");
const APP_ENV_PATH = path.join(APP_ROOT, ".env");
const DOTENV_OPTIONS = { override: true, quiet: true };

function loadEnv() {
  const explicitPath = String(process.env.DOTENV_CONFIG_PATH ?? "").trim();
  if (explicitPath) {
    dotenv.config({ ...DOTENV_OPTIONS, path: explicitPath });
    return;
  }

  const rootResult = dotenv.config({ ...DOTENV_OPTIONS, path: ROOT_ENV_PATH });
  if (!rootResult.error) return;

  dotenv.config({ ...DOTENV_OPTIONS, path: APP_ENV_PATH });
}

loadEnv();
