import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.resolve(process.env.PIT_DATA_DIR || "./data");
const PIT_TOKEN = process.env.PIT_TOKEN || "";
const MAX_BODY = 1024 * 1024;
const PRESENCE_STATES = new Set(["working", "thinking", "waiting", "blocked", "idle", "done"]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
fs.mkdirSync(DATA_DIR, { recursive: true });

const rooms = new Map();

function validName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:@/-]{1,120}$/.test(value);
}

function validRoom(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function roomDir(room) {
  return path.join(DATA_DIR, room);
}

function eventFile(room) {
  return path.join(roomDir(room), "events.jsonl");
}

function loadRoom(room) {
  if (rooms.has(room)) return rooms.get(room);
  fs.mkdirSync(roomDir(room), { recursive: true });
  let nextSeq = 1;
  const file = eventFile(room);
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length) {
      try {
        const last = JSON.parse(lines.at(-1));
        nextSeq = Number(last.seq || 0) + 1;
      } catch {}
    }
  }
  const state = { nextSeq, clients: new Set(), presence: new Map() };
  rooms.set(room, state);
  return state;
}

function readEvents(room, since = 0, limit = 500) {
  const file = eventFile(room);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.seq > since) out.push(event);
    } catch {}
  }
  return out.slice(-Math.max(1, Math.min(limit, 2000)));
}

function appendEvent(room, input) {
  const state = loadRoom(room);
  const event = {
    seq: state.nextSeq++,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    room,
    worker: input.worker,
    type: input.type || "message",
    text: input.text || "",
    to: input.to || null,
    reply_to: input.reply_to || null,
    resource: input.resource || null,
    meta: input.meta && typeof input.meta === "object" ? input.meta : {}
  };
  fs.appendFileSync(eventFile(room), JSON.stringify(event) + "\n");
  broadcast(room, { kind: "event", event });
  return event;
}

function prunePresence(room) {
  const state = loadRoom(room);
  const now = Date.now();
  let changed = false;
  for (const [worker, value] of state.presence) {
    if (value.expires_at_ms <= now) {
      state.presence.delete(worker);
      changed = true;
    }
  }
  return changed;
}

function listPresence(room) {
  prunePresence(room);
  return [...loadRoom(room).presence.values()].map(({ expires_at_ms, ...rest }) => rest);
}

function setPresence(room, input) {
  const state = loadRoom(room);
  const ttl = Math.max(5000, Math.min(Number(input.ttl_ms || 30000), 300000));
  const value = {
    worker: input.worker,
    state: input.state,
    task: input.task || null,
    wait_for: input.wait_for || null,
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttl).toISOString(),
    expires_at_ms: Date.now() + ttl
  };
  state.presence.set(input.worker, value);
  broadcast(room, { kind: "presence", presence: listPresence(room) });
  return value;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function authorized(req, url) {
  if (!PIT_TOKEN) return true;
  const auth = req.headers.authorization || "";
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-pit-token"];
  return headerToken === PIT_TOKEN || url.searchParams.get("token") === PIT_TOKEN;
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sseWrite(res, payload, event = "pit") {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room, payload) {
  const state = loadRoom(room);
  for (const res of state.clients) {
    try {
      sseWrite(res, payload);
    } catch {
      state.clients.delete(res);
    }
  }
}

function staticFile(res, filename, type) {
  const file = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(file)) return false;
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-store"
  });
  res.end(body);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "GET" && pathname === "/") {
    return staticFile(res, "index.html", "text/html; charset=utf-8") || sendJson(res, 404, { error: "UI missing" });
  }

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "convopit" });
  }

  const match = pathname.match(/^\/api\/rooms\/([^/]+)\/(events|presence|stream|state)$/);
  if (!match) return sendJson(res, 404, { error: "not found" });

  const [, room, endpoint] = match;
  if (!validRoom(room)) return sendJson(res, 400, { error: "invalid room" });
  if (!authorized(req, url)) return sendJson(res, 401, { error: "unauthorized" });

  try {
    if (endpoint === "events" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0);
      return sendJson(res, 200, { room, events: readEvents(room, since) });
    }

    if (endpoint === "events" && req.method === "POST") {
      const body = await readJson(req);
      if (!validName(body.worker)) return sendJson(res, 400, { error: "invalid worker" });
      if (typeof body.text !== "string" || !body.text.trim()) return sendJson(res, 400, { error: "text required" });
      if (body.to != null && !validName(body.to)) return sendJson(res, 400, { error: "invalid recipient" });
      if (body.type != null && !validName(body.type)) return sendJson(res, 400, { error: "invalid type" });
      const event = appendEvent(room, body);
      return sendJson(res, 201, { event });
    }

    if (endpoint === "presence" && req.method === "GET") {
      return sendJson(res, 200, { room, presence: listPresence(room) });
    }

    if (endpoint === "presence" && req.method === "POST") {
      const body = await readJson(req);
      if (!validName(body.worker)) return sendJson(res, 400, { error: "invalid worker" });
      if (!PRESENCE_STATES.has(body.state)) return sendJson(res, 400, { error: "invalid state" });
      const presence = setPresence(room, body);
      const { expires_at_ms, ...safe } = presence;
      return sendJson(res, 200, { presence: safe });
    }

    if (endpoint === "state" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0);
      return sendJson(res, 200, {
        room,
        events: readEvents(room, since),
        presence: listPresence(room)
      });
    }

    if (endpoint === "stream" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      res.write(": connected\n\n");
      const state = loadRoom(room);
      state.clients.add(res);
      const since = Number(url.searchParams.get("since") || 0);
      sseWrite(res, {
        kind: "snapshot",
        room,
        events: readEvents(room, since),
        presence: listPresence(room)
      });

      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
      req.on("close", () => {
        clearInterval(keepalive);
        state.clients.delete(res);
      });
      return;
    }

    return sendJson(res, 405, { error: "method not allowed" });
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "bad request" });
  }
});

const presenceTimer = setInterval(() => {
  for (const room of rooms.keys()) {
    if (prunePresence(room)) {
      broadcast(room, { kind: "presence", presence: listPresence(room) });
    }
  }
}, 5000);
presenceTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`ConvoPit listening on http://${HOST}:${PORT}`);
  if (!PIT_TOKEN) console.log("Warning: PIT_TOKEN is not set; API is unauthenticated.");
});

export { server };
