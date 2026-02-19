import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { DAEMON_WS_MESSAGE_TYPES, parseDaemonWsMessage } from "@ultracontext/protocol";
import WebSocket from "ws";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParseMessage(raw) {
  return parseDaemonWsMessage(String(raw ?? ""), null);
}

function errorMessage(error, fallback = "unknown_error") {
  if (!error) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return false;
  }
}

async function readDaemonInfoFile(infoFilePath) {
  const resolved = path.resolve(infoFilePath);
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(raw);
  const port = Number.parseInt(String(parsed?.port ?? ""), 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("invalid daemon info file");
  }
  const pid = Number.parseInt(String(parsed?.pid ?? ""), 10) || 0;
  if (pid > 1 && !isPidAlive(pid)) {
    try {
      await fs.unlink(resolved);
    } catch {
      // ignore stale info cleanup failures
    }
    throw new Error("stale daemon info file");
  }
  return {
    port,
    pid,
    startedAt: String(parsed?.startedAt ?? ""),
    host: String(parsed?.host ?? ""),
  };
}

export function createDaemonWsClient({
  host = "127.0.0.1",
  infoFilePath,
  portFilePath,
  onMessage = () => {},
  onStatus = () => {},
  onError = () => {},
} = {}) {
  const discoveryFilePath = infoFilePath ?? portFilePath;
  let ws = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let connectLoopRunning = false;
  let requestSeq = 0;
  const pendingRequests = new Map();

  const settlePending = (requestId, payload) => {
    if (!pendingRequests.has(requestId)) return false;
    const pending = pendingRequests.get(requestId);
    pendingRequests.delete(requestId);
    pending.resolve(payload);
    return true;
  };

  const rejectPending = (requestId, error) => {
    if (!pendingRequests.has(requestId)) return false;
    const pending = pendingRequests.get(requestId);
    pendingRequests.delete(requestId);
    pending.reject(error);
    return true;
  };

  async function connectOnce() {
    if (!discoveryFilePath) {
      throw new Error("daemon info file path is required");
    }

    const info = await readDaemonInfoFile(discoveryFilePath);
    const url = `ws://${host}:${info.port}`;

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      ws = socket;

      socket.once("open", () => {
        reconnectAttempt = 0;
        onStatus({ connected: true, url, pid: info.pid, port: info.port });
        resolve();
      });

      socket.once("error", (error) => {
        reject(error);
      });

      socket.on("message", (raw) => {
        const msg = safeParseMessage(raw);
        if (!msg || typeof msg !== "object") return;

        if (msg.type === DAEMON_WS_MESSAGE_TYPES.PING) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: DAEMON_WS_MESSAGE_TYPES.PONG, data: { ts: Date.now() } }));
          }
          return;
        }

        if (msg.type === DAEMON_WS_MESSAGE_TYPES.REQUEST_ACK && msg.id) {
          if (msg.ok) {
            settlePending(msg.id, msg.data ?? {});
          } else {
            rejectPending(msg.id, new Error(String(msg.error ?? "request_failed")));
          }
          return;
        }

        onMessage(msg);
      });

      socket.on("close", () => {
        onStatus({ connected: false });
        for (const [id, pending] of pendingRequests.entries()) {
          pending.reject(new Error("socket_closed"));
          pendingRequests.delete(id);
        }
        if (!stopped) {
          void ensureConnectedLoop();
        }
      });
    });
  }

  async function ensureConnectedLoop() {
    if (connectLoopRunning || stopped) return;
    connectLoopRunning = true;
    try {
      while (!stopped) {
        try {
          if (ws && ws.readyState === WebSocket.OPEN) return;
          await connectOnce();
          return;
        } catch (error) {
          onError(error);
          reconnectAttempt += 1;
          const delay = Math.min(1000 * (2 ** Math.min(reconnectAttempt - 1, 3)), 10000);
          await sleep(delay);
        }
      }
    } finally {
      connectLoopRunning = false;
    }
  }

  return {
    async start() {
      stopped = false;
      await ensureConnectedLoop();
    },
    async stop() {
      stopped = true;
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
    },
    isConnected() {
      return Boolean(ws && ws.readyState === WebSocket.OPEN);
    },
    send(type, data = {}) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("socket_not_connected");
      }
      ws.send(JSON.stringify({ type, data }));
    },
    request(type, data = {}, timeoutMs = 8000) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("socket_not_connected"));
      }
      requestSeq += 1;
      const requestId = `req_${Date.now()}_${requestSeq}`;
      ws.send(JSON.stringify({ id: requestId, type, data }));

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error("request_timeout"));
        }, timeoutMs);
        pendingRequests.set(requestId, {
          resolve: (payload) => {
            clearTimeout(timer);
            resolve(payload);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
    formatError(error) {
      return errorMessage(error);
    },
  };
}
