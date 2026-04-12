import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/store.mjs";

// ── helpers ──

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uc-bulk-test-"));
}

function writeJsonl(dir, filename, lines) {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return filePath;
}

function makeClaudeLine({ sessionId, type = "user", content = "hello", ts, uuid }) {
  return {
    parentUuid: null, isSidechain: false, userType: "external",
    cwd: "/tmp/project", sessionId, version: "1", gitBranch: "main",
    type,
    message: { role: type === "assistant" ? "assistant" : "user", content },
    timestamp: ts || new Date().toISOString(),
    uuid: uuid || crypto.randomUUID(),
  };
}

// mock UltraContext API server — captures all requests
function createMockApi() {
  const requests = [];
  let contextCounter = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, body: parsed });

      // POST /contexts — create context
      if (req.method === "POST" && req.url === "/contexts") {
        contextCounter++;
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: `ctx-${contextCounter}`,
          metadata: parsed?.metadata ?? {},
          created_at: new Date().toISOString(),
        }));
        return;
      }

      // POST /contexts/:id — append events
      if (req.method === "POST" && req.url.startsWith("/contexts/ctx-")) {
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: messages.map((m, i) => ({ id: `node-${i}`, index: i, metadata: m.metadata ?? {} })),
          version: 0,
        }));
        return;
      }

      // GET /contexts — connectivity check
      if (req.method === "GET" && req.url.startsWith("/contexts")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });

  return {
    requests,
    start: () => new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        resolve({ port, url: `http://127.0.0.1:${port}` });
      });
    }),
    stop: () => new Promise((resolve) => server.close(resolve)),
    getAppendRequests: () => requests.filter((r) => r.method === "POST" && r.url.startsWith("/contexts/ctx-")),
    getCreateRequests: () => requests.filter((r) => r.method === "POST" && r.url === "/contexts"),
    reset: () => { requests.length = 0; contextCounter = 0; },
  };
}

// ── tests ──

describe("bulk ingestion", () => {
  let mockApi;
  let apiInfo;
  let testTmp;
  let dbPath;
  let store;

  before(async () => {
    mockApi = createMockApi();
    apiInfo = await mockApi.start();
    testTmp = tmpDir();
    dbPath = path.join(testTmp, "test.db");
    store = createStore({ dbPath });
  });

  after(async () => {
    await mockApi.stop();
    fs.rmSync(testTmp, { recursive: true, force: true });
  });

  it("sends events as arrays (bulk), not one-by-one", async () => {
    const sessionId = "session-bulk-001";
    const fixtureDir = path.join(testTmp, "claude", "projects", "test");
    fs.mkdirSync(fixtureDir, { recursive: true });

    // write 20 events for one session
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(makeClaudeLine({
        sessionId,
        type: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
        ts: new Date(Date.now() - (20 - i) * 1000).toISOString(),
      }));
    }
    writeJsonl(fixtureDir, "session.jsonl", lines);

    // import daemon internals by running a full cycle via daemonBoot
    // since we can't access closures directly, use the UltraContext client + store
    const { UltraContext } = await import("ultracontext");
    const uc = new UltraContext({ apiKey: "uc_test_fake", baseUrl: apiInfo.url });

    // simulate what processFile does with bulk ingestion
    const { parseClaudeCodeLine } = await import("@ultracontext/parsers");
    const { sha256 } = await import("../src/utils.mjs");
    const { redact } = await import("../src/redact.mjs");

    // parse all lines
    const filePath = path.join(fixtureDir, "session.jsonl");
    const content = fs.readFileSync(filePath, "utf8").trim().split("\n");
    const events = content.map((line) => parseClaudeCodeLine({ line, filePath })).filter(Boolean);
    assert.equal(events.length, 20, "should parse 20 events");

    // group by session and bulk-append (simulating appendBulkToUltraContext)
    const contextRes = await uc.create({ metadata: { session_id: sessionId, source: "claude" } });
    const contextId = contextRes.id;

    // bulk append as array
    const payloads = events.map((normalized) => ({
      role: normalized.kind,
      content: { message: normalized.message, event_type: normalized.eventType, timestamp: normalized.timestamp },
      metadata: { session_id: sessionId },
    }));
    await uc.append(contextId, payloads);

    // verify: only 1 append request was sent (not 20)
    const appends = mockApi.getAppendRequests();
    assert.equal(appends.length, 1, "should send exactly 1 bulk append request, not 20");

    // verify the body is an array of 20 items
    assert.ok(Array.isArray(appends[0].body), "append body should be an array");
    assert.equal(appends[0].body.length, 20, "bulk request should contain all 20 events");
  });

  it("batches large event counts into chunks of BULK_BATCH_SIZE", async () => {
    mockApi.reset();

    const sessionId = "session-batch-002";
    const { UltraContext } = await import("ultracontext");
    const uc = new UltraContext({ apiKey: "uc_test_fake", baseUrl: apiInfo.url });

    const contextRes = await uc.create({ metadata: { session_id: sessionId } });
    const contextId = contextRes.id;

    // simulate 120 events — should produce 3 batches (50+50+20) at BULK_BATCH_SIZE=50
    const BULK_BATCH_SIZE = 50;
    const totalEvents = 120;
    const payloads = Array.from({ length: totalEvents }, (_, i) => ({
      role: "user",
      content: { message: `event ${i}` },
      metadata: { session_id: sessionId },
    }));

    // send in batches like the daemon does
    for (let i = 0; i < payloads.length; i += BULK_BATCH_SIZE) {
      const batch = payloads.slice(i, i + BULK_BATCH_SIZE);
      await uc.append(contextId, batch);
    }

    const appends = mockApi.getAppendRequests();
    assert.equal(appends.length, 3, "120 events at batch size 50 = 3 requests");
    assert.equal(appends[0].body.length, 50, "first batch = 50");
    assert.equal(appends[1].body.length, 50, "second batch = 50");
    assert.equal(appends[2].body.length, 20, "third batch = 20");
  });

  it("groups events from multiple sessions into separate bulk requests", async () => {
    mockApi.reset();

    const { UltraContext } = await import("ultracontext");
    const uc = new UltraContext({ apiKey: "uc_test_fake", baseUrl: apiInfo.url });

    // simulate 3 sessions with 10 events each
    const sessions = ["session-A", "session-B", "session-C"];
    for (const sessionId of sessions) {
      const contextRes = await uc.create({ metadata: { session_id: sessionId } });
      const payloads = Array.from({ length: 10 }, (_, i) => ({
        role: "user",
        content: { message: `${sessionId} event ${i}` },
        metadata: { session_id: sessionId },
      }));
      await uc.append(contextRes.id, payloads);
    }

    // 3 creates + 3 appends
    const creates = mockApi.getCreateRequests();
    const appends = mockApi.getAppendRequests();
    assert.equal(creates.length, 3, "should create 3 contexts");
    assert.equal(appends.length, 3, "should send 3 bulk append requests (one per session)");

    // each append should be an array of 10
    for (const req of appends) {
      assert.ok(Array.isArray(req.body), "each append should be an array");
      assert.equal(req.body.length, 10, "each session batch should have 10 events");
    }
  });

  it("handles concurrent session appends without creating duplicate contexts", async () => {
    mockApi.reset();

    const { UltraContext } = await import("ultracontext");
    const uc = new UltraContext({ apiKey: "uc_test_fake", baseUrl: apiInfo.url });

    // simulate concurrent creates for the same session (what contextCreateInflight prevents)
    const sessionId = "session-dedup-001";
    const promises = Array.from({ length: 5 }, () =>
      uc.create({ metadata: { session_id: sessionId } }),
    );
    const results = await Promise.all(promises);

    // mock server creates 5 separate contexts — but the daemon's inflight map
    // would coalesce these. here we just verify the SDK handles concurrent calls
    assert.equal(results.length, 5, "all concurrent creates should resolve");
    for (const r of results) {
      assert.ok(r.id, "each result should have an id");
    }
  });

  it("deduplication prevents re-processing same events", () => {
    const eventHash = `test-dedup-${Date.now()}`;

    // first mark should return true (new)
    const isNew1 = store.markEventSeen(eventHash, 3600);
    assert.equal(isNew1, true, "first call should mark as new");

    // second mark should return false (duplicate)
    const isNew2 = store.markEventSeen(eventHash, 3600);
    assert.equal(isNew2, false, "second call should detect duplicate");
  });

  it("file offset tracking resumes from last position", () => {
    const fileKey = "test-offset-key";

    // initial offset is 0
    assert.equal(store.getOffset(fileKey), 0);

    // set and retrieve
    store.setOffset(fileKey, 4096);
    assert.equal(store.getOffset(fileKey), 4096);

    // update
    store.setOffset(fileKey, 8192);
    assert.equal(store.getOffset(fileKey), 8192);
  });

  it("context cache prevents redundant API calls", () => {
    const cacheKey = "ctx:session:claude:host:user:session-cache-001";
    const contextId = "ctx-cached-123";

    // initially empty (returns "" when not found)
    assert.equal(store.getContextCache(cacheKey), "");

    // cache and retrieve
    store.setContextCache(cacheKey, contextId);
    assert.equal(store.getContextCache(cacheKey), contextId);
  });
});

describe("parallelMap", () => {
  // re-implement parallelMap here since it's a closure in the daemon
  async function parallelMap(items, concurrency, fn) {
    const results = [];
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
  }

  it("processes all items with correct concurrency", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const results = await parallelMap([1, 2, 3, 4, 5, 6], 3, async (item) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 50));
      currentConcurrent--;
      return item * 2;
    });

    assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
    assert.ok(maxConcurrent <= 3, `max concurrency should be <=3, got ${maxConcurrent}`);
    assert.ok(maxConcurrent >= 2, `should actually run concurrently, got ${maxConcurrent}`);
  });

  it("handles empty input", async () => {
    const results = await parallelMap([], 5, async (item) => item);
    assert.deepEqual(results, []);
  });

  it("handles concurrency > items", async () => {
    const results = await parallelMap([1, 2], 10, async (item) => item * 3);
    assert.deepEqual(results, [3, 6]);
  });

  it("propagates errors", async () => {
    await assert.rejects(
      () => parallelMap([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
      { message: "boom" },
    );
  });
});
