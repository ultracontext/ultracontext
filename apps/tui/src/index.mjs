import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tuiEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../daemon/src/index.mjs"
);

const child = spawn(process.execPath, [tuiEntry], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
