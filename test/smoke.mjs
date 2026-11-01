import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = 18787;
const data = fs.mkdtempSync(path.join(os.tmpdir(), "convopit-"));
const child = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PIT_DATA_DIR: data, PIT_SECRET: "smoke-secret" },
  stdio: ["ignore", "pipe", "pipe"]
});

const base = `http://127.0.0.1:${port}`;
const json = { "content-type": "application/json" };
const auth = token => ({ ...json, authorization: "Bearer " + token });

async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}
async function expectStatus(response, status, label) {
  if (response.status !== status) throw new Error(`${label}: expected ${status}, got ${response.status}: ${await response.text()}`);
  return response;
}

try {
  await waitForHealth();

  let r = await fetch(base + "/api/rooms", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Importer review", visibility: "private", worker: "owner" })
  });
  await expectStatus(r, 201, "create room");
  const created = await r.json();
  const room = created.room.id;
  const adminToken = created.token;
  if (created.room.visibility !== "private") throw new Error("room visibility wrong");
  if (!created.address.startsWith("/r/")) throw new Error("room address missing");
  if (!/^pit-[0-9a-f]{20}$/.test(room)) throw new Error("private room address is not opaque");

  r = await fetch(base + `/api/rooms/${room}/info`);
  await expectStatus(r, 200, "public room info");
  const anonymousInfo = await r.json();
  if (anonymousInfo.room.name) throw new Error("private room leaked its name");

  r = await fetch(base + `/api/rooms/${room}/state`);
  await expectStatus(r, 401, "private room must reject anonymous read");

  r = await fetch(base + `/api/rooms/${room}/access-requests`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      name: "Parser",
      worker: "worker-a",
      requested_role: "write",
      message: "Need to answer importer questions"
    })
  });
  await expectStatus(r, 201, "request access");
  const requested = await r.json();

  r = await fetch(base + `/api/rooms/${room}/access-requests`, { headers: auth(adminToken) });
  await expectStatus(r, 200, "admin list requests");
  const requests = await r.json();
  if (requests.requests.length !== 1 || requests.requests[0].status !== "pending") throw new Error("pending request missing");

  r = await fetch(base + `/api/rooms/${room}/access-requests`, {
    method: "POST",
    headers: auth(adminToken),
    body: JSON.stringify({ action: "approve", request_id: requested.request.id, role: "write" })
  });
  await expectStatus(r, 200, "approve request");

  r = await fetch(base + `/api/rooms/${room}/access-request-status?id=${encodeURIComponent(requested.request.id)}`, {
    headers: { "x-request-secret": requested.request_secret }
  });
  await expectStatus(r, 200, "requester retrieve approval");
  const approved = await r.json();
  if (approved.request.status !== "approved" || !approved.request.token) throw new Error("approved invite missing");
  const workerToken = approved.request.token;

  r = await fetch(base + `/api/rooms/${room}/presence`, {
    method: "POST",
    headers: auth(workerToken),
    body: JSON.stringify({ worker: "worker-a", state: "working", task: "smoke test", ttl_ms: 30000 })
  });
  await expectStatus(r, 200, "presence");

  r = await fetch(base + `/api/rooms/${room}/events`, {
    method: "POST",
    headers: auth(workerToken),
    body: JSON.stringify({ worker: "worker-b", type: "message", text: "impersonation attempt" })
  });
  await expectStatus(r, 400, "worker-bound invite must reject impersonation");

  r = await fetch(base + `/api/rooms/${room}/events`, {
    method: "POST",
    headers: auth(workerToken),
    body: JSON.stringify({ worker: "worker-a", type: "question", to: "owner", text: "Can you see this?" })
  });
  await expectStatus(r, 201, "post event");

  const controller = new AbortController();
  r = await fetch(base + `/api/rooms/${room}/stream?since=0`, { headers: auth(workerToken), signal: controller.signal });
  await expectStatus(r, 200, "SSE stream");
  const reader = r.body.getReader();
  const first = await reader.read();
  controller.abort();
  const streamText = new TextDecoder().decode(first.value || new Uint8Array());
  if (!streamText.includes("connected")) throw new Error("SSE did not open");

  r = await fetch(base + `/api/rooms/${room}/settings`, {
    method: "POST",
    headers: auth(adminToken),
    body: JSON.stringify({ visibility: "public" })
  });
  await expectStatus(r, 200, "make room public");

  r = await fetch(base + `/api/rooms/${room}/state`);
  await expectStatus(r, 200, "public room anonymous read");
  const state = await r.json();
  if (state.events.length !== 1 || state.presence.length !== 1) throw new Error("state missing event or presence");

  r = await fetch(base + "/api/config");
  const config = await r.json();
  if (!String(config.donation_url).includes("creakyca")) throw new Error("donation link missing");

  const disk = fs.readFileSync(path.join(data, "rooms", room, "events.jsonl"), "utf8");
  if (!disk.includes("Can you see this?")) throw new Error("append-only event log missing");

  console.log("smoke test passed");
} finally {
  child.kill("SIGTERM");
  fs.rmSync(data, { recursive: true, force: true });
}
