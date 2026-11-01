import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.resolve(process.env.PIT_DATA_DIR || "./data");
const MAX_BODY = 1024 * 1024;
const DONATION_URL = process.env.DONATION_URL || "https://cash.app/$creakyca";
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
function validRequestId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function roomDir(room) { return path.join(DATA_DIR, "rooms", room); }
function eventFile(room) { return path.join(roomDir(room), "events.jsonl"); }
function roomMetaFile(room) { return path.join(roomDir(room), "room.json"); }
function requestDir(room) { return path.join(roomDir(room), "access-requests"); }
function requestFile(room, id) { return path.join(requestDir(room), id + ".json"); }
function roomExists(room) { return fs.existsSync(roomMetaFile(room)); }
function makeRoomId(input, visibility) {
  if (visibility === "private") return `pit-${crypto.randomBytes(10).toString("hex")}`;
  const base = String(input || "pit").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "pit";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

function createRoom({ name, visibility = "private" }) {
  if (!ROOM_VISIBILITIES.has(visibility)) throw new Error("invalid visibility");
  let id;
  do { id = makeRoomId(name, visibility); } while (roomExists(id));
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
function hashRequestSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}
function publicRequest(value, includeInvite = false) {
  const out = {
    id: value.id,
    room: value.room,
    name: value.name,
    worker: value.worker,
    message: value.message,
    requested_role: value.requested_role,
    status: value.status,
    created_at: value.created_at,
    resolved_at: value.resolved_at || null
  };
  if (includeInvite && value.status === "approved") {
    out.role = value.role;
    out.invite_url = value.invite_url;
    out.token = value.token;
  }
  return out;
}
function createAccessRequest(room, input) {
  const requestedRole = input.requested_role || "write";
  if (!["read", "write"].includes(requestedRole)) throw new Error("requested role must be read or write");
  if (input.worker != null && input.worker !== "" && !validName(input.worker)) throw new Error("invalid worker");
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(24).toString("base64url");
  const value = {
    id,
    room,
    name: String(input.name || "").trim().slice(0, 120) || null,
    worker: input.worker || null,
    message: String(input.message || "").trim().slice(0, 1000) || null,
    requested_role: requestedRole,
    status: "pending",
    created_at: new Date().toISOString(),
    secret_hash: hashRequestSecret(secret)
  };
  fs.mkdirSync(requestDir(room), { recursive: true });
  fs.writeFileSync(requestFile(room, id), JSON.stringify(value, null, 2));
  return { request: publicRequest(value), secret };
}
function readAccessRequest(room, id) {
  if (!validRequestId(id)) return null;
  const file = requestFile(room, id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeAccessRequest(room, value) {
  fs.mkdirSync(requestDir(room), { recursive: true });
  fs.writeFileSync(requestFile(room, value.id), JSON.stringify(value, null, 2));
}
function listAccessRequests(room) {
  const dir = requestDir(room);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try { out.push(publicRequest(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))); } catch {}
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
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

  const publicRoomMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/(info|access-requests|access-request-status)$/);
  if (publicRoomMatch) {
    const [, room, endpoint] = publicRoomMatch;
    if (!validRoom(room) || !roomExists(room)) return sendJson(res, 404, { error: "room not found" });
    try {
      if (endpoint === "info" && req.method === "GET") {
        const meta = loadRoomMeta(room);
        const invited = verifyInvite(getBearer(req), room);
        if (meta.visibility === "private" && !can(invited, "read")) {
          return sendJson(res, 200, { room: { id: meta.id, visibility: meta.visibility } });
        }
        return sendJson(res, 200, { room: meta });
      }
      if (endpoint === "access-requests" && req.method === "POST") {
        const admin = verifyInvite(getBearer(req), room);
        const body = await readJson(req);
        if (admin && can(admin, "admin") && body.action) {
          const value = readAccessRequest(room, body.request_id);
          if (!value) return sendJson(res, 404, { error: "request not found" });
          if (value.status !== "pending") return sendJson(res, 409, { error: "request already resolved" });
          if (body.action === "deny") {
            value.status = "denied";
            value.resolved_at = new Date().toISOString();
            writeAccessRequest(room, value);
            broadcast(room, { kind: "access_request", request: publicRequest(value) });
            return sendJson(res, 200, { request: publicRequest(value) });
          }
          if (body.action === "approve") {
            const role = body.role || value.requested_role || "write";
            if (!["read", "write"].includes(role)) return sendJson(res, 400, { error: "approval role must be read or write" });
            const token = mintInvite({ room, role, worker: value.worker || null, expires_in_seconds: body.expires_in_seconds || null });
            value.status = "approved";
            value.role = role;
            value.token = token;
            value.invite_url = `/r/${room}#invite=${token}`;
            value.resolved_at = new Date().toISOString();
            writeAccessRequest(room, value);
            broadcast(room, { kind: "access_request", request: publicRequest(value) });
            return sendJson(res, 200, { request: publicRequest(value, true) });
          }
          return sendJson(res, 400, { error: "action must be approve or deny" });
        }
        const made = createAccessRequest(room, body);
        broadcast(room, { kind: "access_request", request: made.request });
        return sendJson(res, 201, {
          request: made.request,
          request_secret: made.secret,
          status_url: `/api/rooms/${room}/access-request-status?id=${made.request.id}`
        });
      }
      if (endpoint === "access-requests" && req.method === "GET") {
        const admin = verifyInvite(getBearer(req), room);
        if (!can(admin, "admin")) return sendJson(res, 401, { error: "admin invite required" });
        return sendJson(res, 200, { requests: listAccessRequests(room) });
      }
      if (endpoint === "access-request-status" && req.method === "GET") {
        const id = url.searchParams.get("id") || "";
        const secret = req.headers["x-request-secret"] || "";
        const value = readAccessRequest(room, id);
        if (!value || !secret || hashRequestSecret(secret) !== value.secret_hash) return sendJson(res, 404, { error: "request not found" });
        return sendJson(res, 200, { request: publicRequest(value, true) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || "bad request" });
    }
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
