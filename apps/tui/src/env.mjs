// env loader — optional dotenv (no-op when running via SDK global install)
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const ROOT_ENV_PATH = path.join(REPO_ROOT, ".env");
const APP_ENV_PATH = path.join(APP_ROOT, ".env");
const DAEMON_ENV_PATH = path.join(REPO_ROOT, "apps", "daemon", ".env");
const DOTENV_OPTIONS = { override: true, quiet: true };

try {
  const dotenv = await import("dotenv");

  const explicitPath = String(process.env.DOTENV_CONFIG_PATH ?? "").trim();
  if (explicitPath) {
    dotenv.config({ ...DOTENV_OPTIONS, path: explicitPath });
  } else {
    const rootResult = dotenv.config({ ...DOTENV_OPTIONS, path: ROOT_ENV_PATH });
    if (!rootResult.error) { /* loaded from root */ }
    else {
      const appResult = dotenv.config({ ...DOTENV_OPTIONS, path: APP_ENV_PATH });
      if (appResult.error) dotenv.config({ ...DOTENV_OPTIONS, path: DAEMON_ENV_PATH });
    }
  }
} catch {
  // dotenv not installed — running via SDK global install, env already set
}
