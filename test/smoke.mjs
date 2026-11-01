import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = 18787;
const data = fs.mkdtempSync(path.join(os.tmpdir(), "convopit-"));
const child = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PIT_DATA_DIR: data, PIT_TOKEN: "test-token" },
  stdio: ["ignore", "pipe", "pipe"]
});

const base = `http://127.0.0.1:${port}`;
const headers = { "content-type": "application/json", authorization: "Bearer test-token" };

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

try {
  await waitForHealth();

  let r = await fetch(base + "/api/rooms/test/presence", {
    method: "POST",
    headers,
    body: JSON.stringify({ worker: "worker-a", state: "working", task: "smoke test", ttl_ms: 30000 })
  });
  if (!r.ok) throw new Error("presence post failed");

  r = await fetch(base + "/api/rooms/test/events", {
    method: "POST",
    headers,
    body: JSON.stringify({ worker: "worker-a", type: "question", to: "worker-b", text: "Can you see this?" })
  });
  if (r.status !== 201) throw new Error("event post failed");

  r = await fetch(base + "/api/rooms/test/state", { headers });
  const state = await r.json();
  if (state.events.length !== 1) throw new Error("event was not persisted");
  if (state.events[0].seq !== 1) throw new Error("sequence is wrong");
  if (state.presence.length !== 1) throw new Error("presence missing");

  const disk = fs.readFileSync(path.join(data, "test", "events.jsonl"), "utf8");
  if (!disk.includes("Can you see this?")) throw new Error("append-only log missing event");

  console.log("smoke test passed");
} finally {
  child.kill("SIGTERM");
  fs.rmSync(data, { recursive: true, force: true });
}
