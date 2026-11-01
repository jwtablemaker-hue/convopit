import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.resolve(process.env.PIT_DATA_DIR || "./data");
const MAX_BODY = 1024 * 1024;
const DONATION_URL = process.env.DONATION_URL || "";
const ROOM_VISIBILITIES = new Set(["private", "public"]);
const PRESENCE_STATES = new Set(["working", "thinking", "waiting", "blocked", "idle", "done"]);
const VALID_SCOPES = new Set(["read", "write", "admin"]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSecret() {
  if (process.env.PIT_SECRET) return process.env.PIT_SECRET;
  const file = path.join(DATA_DIR, ".pit-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const PIT_SECRET = loadSecret();

const rooms = new Map();

function b64urlEncode(input) {
  return Buffer.from(input).toString("base64url");
}
function b64urlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}
function sign(data) {
  return crypto.createHmac("sha256", PIT_SECRET).update(data).digest("base64url");
}
function mintInvite({ room, role = "write", worker = null, expires_in_seconds = null }) {
  if (!VALID_SCOPES.has(role)) throw new Error("invalid role");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    jti: crypto.randomUUID(),
    room,
    role,
    worker: worker || null,
    iat: now,
    exp: expires_in_seconds ? now + Math.max(60, Math.min(Number(expires_in_seconds), 60 * 60 * 24 * 365)) : null
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}
function verifyInvite(token, room) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".", 2);
  const expected = sign(encoded);
  const a = Buffer.from(signature || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(encoded)); } catch { return null; }
  if (payload.v !== 1 || payload.room !== room || !VALID_SCOPES.has(payload.role)) return null;
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}
function can(auth, required) {
  if (!auth) return false;
  const rank = { read: 1, write: 2, admin: 3 };
  return rank[auth.role] >= rank[required];
}
function getBearer(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

function validName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:@/-]{1,120}$/.test(value);
}
function validRoom(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value);
}
function roomDir(room) { return path.join(DATA_DIR, "rooms", room); }
function eventFile(room) { return path.join(roomDir(room), "events.jsonl"); }
function roomMetaFile(room) { return path.join(roomDir(room), "room.json"); }
function roomExists(room) { return fs.existsSync(roomMetaFile(room)); }
function makeRoomId(input) {
  const base = String(input || "pit").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "pit";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

function createRoom({ name, visibility = "private" }) {
  if (!ROOM_VISIBILITIES.has(visibility)) throw new Error("invalid visibility");
  let id;
  do { id = makeRoomId(name); } while (roomExists(id));
  fs.mkdirSync(roomDir(id), { recursive: true });
  const meta = {
    id,
    name: String(name || id).slice(0, 120),
    visibility,
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(roomMetaFile(id), JSON.stringify(meta, null, 2));
  return meta;
}
function updateRoomMeta(room, patch) {
  const meta = loadRoomMeta(room);
  if (!meta) throw new Error("room not found");
  if (patch.visibility != null) {
    if (!ROOM_VISIBILITIES.has(patch.visibility)) throw new Error("invalid visibility");
    meta.visibility = patch.visibility;
  }
  if (patch.name != null) meta.name = String(patch.name).slice(0, 120);
  meta.updated_at = new Date().toISOString();
  fs.writeFileSync(roomMetaFile(room), JSON.stringify(meta, null, 2));
  return meta;
}
function loadRoomMeta(room) {
  if (!roomExists(room)) return null;
  return JSON.parse(fs.readFileSync(roomMetaFile(room), "utf8"));
}
function loadRoom(room) {
  if (rooms.has(room)) return rooms.get(room);
  fs.mkdirSync(roomDir(room), { recursive: true });
  let nextSeq = 1;
  const file = eventFile(room);
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length) {
      try { nextSeq = Number(JSON.parse(lines.at(-1)).seq || 0) + 1; } catch {}
    }
  }
  const state = { nextSeq, clients: new Set(), presence: new Map() };
  rooms.set(room, state);
  return state;
}
function readEvents(room, since = 0, limit = 500) {
  const file = eventFile(room);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.seq > since) out.push(event);
    } catch {}
  }
  return out.slice(-Math.max(1, Math.min(limit, 2000)));
}
function appendEvent(room, input, auth) {
  const state = loadRoom(room);
  const worker = auth.worker || input.worker;
  if (!validName(worker)) throw new Error("invalid worker");
  if (auth.worker && input.worker && input.worker !== auth.worker) throw new Error("invite is bound to another worker");
  const event = {
    seq: state.nextSeq++, id: crypto.randomUUID(), ts: new Date().toISOString(), room,
    worker, type: input.type || "message", text: input.text || "", to: input.to || null,
    reply_to: input.reply_to || null, resource: input.resource || null,
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
    if (value.expires_at_ms <= now) { state.presence.delete(worker); changed = true; }
  }
  return changed;
}
function listPresence(room) {
  prunePresence(room);
  return [...loadRoom(room).presence.values()].map(({ expires_at_ms, ...rest }) => rest);
}
function setPresence(room, input, auth) {
  const worker = auth.worker || input.worker;
  if (!validName(worker)) throw new Error("invalid worker");
  if (auth.worker && input.worker && input.worker !== auth.worker) throw new Error("invite is bound to another worker");
  const state = loadRoom(room);
  const ttl = Math.max(5000, Math.min(Number(input.ttl_ms || 30000), 300000));
  const value = {
    worker, state: input.state, task: input.task || null, wait_for: input.wait_for || null,
    updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttl).toISOString(), expires_at_ms: Date.now() + ttl
  };
  state.presence.set(worker, value);
  broadcast(room, { kind: "presence", presence: listPresence(room) });
  return value;
}
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}
async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}
function sseWrite(res, payload, event = "pit") { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
function broadcast(room, payload) {
  const state = loadRoom(room);
  for (const res of state.clients) {
    try { sseWrite(res, payload); } catch { state.clients.delete(res); }
  }
}
function staticFile(res, filename, type) {
  const file = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(file)) return false;
  const body = fs.readFileSync(file);
  res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store" });
  res.end(body); return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "GET" && pathname === "/") return staticFile(res, "index.html", "text/html; charset=utf-8") || sendJson(res, 404, { error: "UI missing" });
  if (req.method === "GET" && /^\/r\/[a-z0-9_-]+$/.test(pathname)) return staticFile(res, "index.html", "text/html; charset=utf-8") || sendJson(res, 404, { error: "UI missing" });
  if (req.method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, service: "convopit" });
  if (req.method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, { donation_url: DONATION_URL || null });
  }

  if (req.method === "POST" && pathname === "/api/rooms") {
    try {
      const body = await readJson(req);
      const room = createRoom({ name: body.name, visibility: body.visibility || "private" });
      const token = mintInvite({ room: room.id, role: "admin", worker: body.worker || null });
      return sendJson(res, 201, { room, token, address: `/r/${room.id}`, invite_url: `/r/${room.id}#invite=${token}` });
    } catch (error) { return sendJson(res, 400, { error: error.message || "bad request" }); }
  }

  const match = pathname.match(/^\/api\/rooms\/([^/]+)\/(events|presence|stream|state|invites|me|settings)$/);
  if (!match) return sendJson(res, 404, { error: "not found" });
  const [, room, endpoint] = match;
  if (!validRoom(room) || !roomExists(room)) return sendJson(res, 404, { error: "room not found" });

  const roomMeta = loadRoomMeta(room);
  let auth = verifyInvite(getBearer(req), room);
  if (!auth && roomMeta.visibility === "public" && req.method === "GET" && endpoint !== "invites" && endpoint !== "settings") {
    auth = { role: "read", worker: null, exp: null, public: true };
  }
  const needed = (endpoint === "invites" || endpoint === "settings") ? "admin" : (req.method === "GET" ? "read" : "write");
  if (!can(auth, needed)) return sendJson(res, 401, { error: "invalid or insufficient invite" });

  try {
    if (endpoint === "me" && req.method === "GET") {
      return sendJson(res, 200, { room: loadRoomMeta(room), access: { role: auth.role, worker: auth.worker, exp: auth.exp, public: !!auth.public } });
    }
    if (endpoint === "settings" && req.method === "POST") {
      const body = await readJson(req);
      const updated = updateRoomMeta(room, { visibility: body.visibility, name: body.name });
      broadcast(room, { kind: "room", room: updated });
      return sendJson(res, 200, { room: updated });
    }
    if (endpoint === "invites" && req.method === "POST") {
      const body = await readJson(req);
      const role = body.role || "write";
      if (!VALID_SCOPES.has(role)) return sendJson(res, 400, { error: "invalid role" });
      if (body.worker != null && !validName(body.worker)) return sendJson(res, 400, { error: "invalid worker" });
      const token = mintInvite({ room, role, worker: body.worker || null, expires_in_seconds: body.expires_in_seconds || null });
      return sendJson(res, 201, { token, role, worker: body.worker || null, invite_url: `/r/${room}#invite=${token}` });
    }
    if (endpoint === "events" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0);
      return sendJson(res, 200, { room, events: readEvents(room, since) });
    }
    if (endpoint === "events" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.text !== "string" || !body.text.trim()) return sendJson(res, 400, { error: "text required" });
      if (body.to != null && !validName(body.to)) return sendJson(res, 400, { error: "invalid recipient" });
      if (body.type != null && !validName(body.type)) return sendJson(res, 400, { error: "invalid type" });
      return sendJson(res, 201, { event: appendEvent(room, body, auth) });
    }
    if (endpoint === "presence" && req.method === "GET") return sendJson(res, 200, { room, presence: listPresence(room) });
    if (endpoint === "presence" && req.method === "POST") {
      const body = await readJson(req);
      if (!PRESENCE_STATES.has(body.state)) return sendJson(res, 400, { error: "invalid state" });
      const value = setPresence(room, body, auth);
      const { expires_at_ms, ...safe } = value;
      return sendJson(res, 200, { presence: safe });
    }
    if (endpoint === "state" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0);
      return sendJson(res, 200, { room: loadRoomMeta(room), events: readEvents(room, since), presence: listPresence(room) });
    }
    if (endpoint === "stream" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(": connected\n\n");
      const state = loadRoom(room); state.clients.add(res);
      const since = Number(url.searchParams.get("since") || 0);
      sseWrite(res, { kind: "snapshot", room: loadRoomMeta(room), events: readEvents(room, since), presence: listPresence(room) });
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
      req.on("close", () => { clearInterval(keepalive); state.clients.delete(res); });
      return;
    }
    return sendJson(res, 405, { error: "method not allowed" });
  } catch (error) { return sendJson(res, 400, { error: error.message || "bad request" }); }
});

const presenceTimer = setInterval(() => {
  for (const room of rooms.keys()) if (prunePresence(room)) broadcast(room, { kind: "presence", presence: listPresence(room) });
}, 5000);
presenceTimer.unref();

server.listen(PORT, HOST, () => console.log(`ConvoPit listening on http://${HOST}:${PORT}`));
export { server };
