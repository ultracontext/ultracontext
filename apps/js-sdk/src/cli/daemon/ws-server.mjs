import fs from "node:fs/promises";
import path from "node:path";

import {
  DAEMON_WS_MESSAGE_TYPES,
  buildDaemonWsMessage,
  parseDaemonWsMessage,
} from "../protocol/index.mjs";
import { WebSocket, WebSocketServer } from "ws";

function safeParseMessage(raw) {
  return parseDaemonWsMessage(String(raw ?? ""), null);
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function safeErrorMessage(error, fallback = "unknown_error") {
  if (!error) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function createWsServer({
  host,
  port,
  infoFilePath,
  portFilePath,
  heartbeatMs = 5000,
  getSnapshot = () => ({}),
  getLogs = () => [],
  getConfig = () => ({}),
  onCommand = async () => ({}),
} = {}) {
  const clients = new Set();
  let wss = null;
  let heartbeatTimer = null;
  let currentPort = 0;
  const discoveryFilePath = infoFilePath ?? portFilePath;

  const broadcast = (message) => {
    for (const client of clients) safeSend(client, message);
  };

  const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const client of clients) {
        const lastPong = Number(client.__ucLastPong ?? 0);
        if (lastPong && now - lastPong > heartbeatMs * 3) {
          try {
            client.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        safeSend(client, buildDaemonWsMessage(DAEMON_WS_MESSAGE_TYPES.PING, { ts: now }));
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  };

  async function writePortFile() {
    if (!discoveryFilePath) return;
    const resolved = path.resolve(discoveryFilePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const payload = {
      pid: process.pid,
      host,
      port: currentPort,
      startedAt: new Date().toISOString(),
    };
    await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  async function removePortFile() {
    if (!discoveryFilePath) return;
    try {
      await fs.unlink(path.resolve(discoveryFilePath));
    } catch {
      // ignore
    }
  }

  return {
    async start() {
      if (wss) return { host, port: currentPort };
      wss = new WebSocketServer({ host, port });

      await new Promise((resolve, reject) => {
        const onError = (error) => {
          wss?.off?.("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          wss?.off?.("error", onError);
          resolve();
        };
        wss.once("error", onError);
        wss.once("listening", onListening);
      });

      const address = wss.address();
      currentPort = typeof address === "object" && address ? Number(address.port ?? 0) : Number(port ?? 0);
      await writePortFile();

      wss.on("connection", (ws) => {
        ws.__ucLastPong = Date.now();
        clients.add(ws);

        safeSend(ws, {
          type: DAEMON_WS_MESSAGE_TYPES.SNAPSHOT,
          data: {
            state: getSnapshot(),
            recentLogs: getLogs(),
            config: getConfig(),
            clients: clients.size,
          },
        });

        ws.on("message", async (raw) => {
          const msg = safeParseMessage(raw);
          if (!msg || typeof msg !== "object") return;

          if (msg.type === DAEMON_WS_MESSAGE_TYPES.PONG) {
            ws.__ucLastPong = Date.now();
            return;
          }

          const requestId = msg.id ?? null;
          try {
            const result = await onCommand(msg, { clients: clients.size });
            safeSend(ws, {
              type: DAEMON_WS_MESSAGE_TYPES.REQUEST_ACK,
              id: requestId,
              ok: true,
              data: result ?? {},
            });
          } catch (error) {
            safeSend(ws, {
              type: DAEMON_WS_MESSAGE_TYPES.REQUEST_ACK,
              id: requestId,
              ok: false,
              error: safeErrorMessage(error),
            });
          }
        });

        ws.on("close", () => {
          clients.delete(ws);
          broadcast({
            type: DAEMON_WS_MESSAGE_TYPES.STATE,
            data: {
              ...getSnapshot(),
              clients: clients.size,
            },
          });
        });

        ws.on("error", () => {
          clients.delete(ws);
        });
      });

      startHeartbeat();
      return { host, port: currentPort };
    },
    broadcastState() {
      broadcast({
        type: DAEMON_WS_MESSAGE_TYPES.STATE,
        data: {
          ...getSnapshot(),
          clients: clients.size,
        },
      });
    },
    broadcastLog(entry) {
      broadcast(buildDaemonWsMessage(DAEMON_WS_MESSAGE_TYPES.LOG, entry));
    },
    broadcastEvent(event) {
      broadcast(buildDaemonWsMessage(DAEMON_WS_MESSAGE_TYPES.CONTEXT_EVENT, event));
    },
    broadcastConfig() {
      broadcast(buildDaemonWsMessage(DAEMON_WS_MESSAGE_TYPES.CONFIG_STATE, getConfig()));
    },
    clientCount() {
      return clients.size;
    },
    async stop() {
      stopHeartbeat();
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      clients.clear();

      if (wss) {
        await new Promise((resolve) => {
          wss.close(() => resolve());
        });
        wss = null;
      }
      await removePortFile();
    },
  };
}
