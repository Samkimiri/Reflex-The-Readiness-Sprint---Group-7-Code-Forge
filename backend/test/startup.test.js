const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

// Regression test for the JWT_SECRET fail-fast check in server.js. This
// can't run in the same process as api.test.js — the check only runs once,
// at module load, and the module is already cached by the time any test
// there executes — so each case here spawns a real, fresh `node` process
// with a controlled environment and observes what actually happens.
const SERVER_PATH = path.join(__dirname, "..", "server.js");
const LOCAL_DB_FILE = path.join(__dirname, "..", "data", "db.json");

// A real crash from the fail-fast check happens near-instantly (well under
// a second locally), but this spawns a genuinely fresh `node` process each
// time, and CI/dev machines can have enough contention under load to push
// cold-start latency higher than you'd expect — generous margin here trades
// a slightly slower failure-case test for not flaking under normal load.
function runServer(env, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_PATH], { env: { ...process.env, ...env } });
    let stderr = "";
    // Must actually drain this — an unread stderr pipe can fill its OS
    // buffer and block the child process from writing/exiting at all
    // (worse on Windows), which looks exactly like "never crashed."
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", () => {}); // same pipe-draining reason, just discarded — nothing here is asserted on
    const timer = setTimeout(() => {
      // Didn't crash within the window — treat as "started successfully".
      child.kill();
      resolve({ crashed: false, stderr });
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ crashed: code !== 0, code, stderr });
    });
  });
}

test("startup refuses to run with NODE_ENV=production (not just on Vercel) and no JWT_SECRET", async () => {
  // VERCEL explicitly cleared — this is the actual gap that was fixed: the
  // check used to only look for the VERCEL env var, so any other platform
  // (Render, Railway, ...) with NODE_ENV=production set could silently
  // start signing tokens with the hardcoded dev secret. Crashes before
  // touching the DB at all, so no cleanup needed here.
  const result = await runServer({ NODE_ENV: "production", VERCEL: "", JWT_SECRET: "" });
  assert.equal(result.crashed, true);
  assert.match(result.stderr, /JWT_SECRET must be set/);
});

test("startup succeeds once JWT_SECRET is set, regardless of which platform signal (VERCEL or NODE_ENV) triggered the check", async () => {
  // VERCEL=1 here just reuses the same tmpdir DB isolation api.test.js
  // relies on, so this doesn't touch the shared backend/data/db.json a
  // developer's own `npm start` also writes to — not asserting anything
  // about which signal fired, only that a real secret is enough either way.
  const result = await runServer({ NODE_ENV: "production", VERCEL: "1", JWT_SECRET: "a-real-looking-secret-for-this-test-only", PORT: "5799" });
  assert.equal(result.crashed, false);
});

test("plain local dev (npm start, no NODE_ENV/VERCEL set) doesn't require JWT_SECRET", async () => {
  try {
    const result = await runServer({ NODE_ENV: "", VERCEL: "", JWT_SECRET: "", PORT: "5798" });
    assert.equal(result.crashed, false);
  } finally {
    // This case genuinely exercises the same local-file DB path `npm start`
    // uses (VERCEL unset) — clean up the seed data it leaves behind.
    fs.rmSync(LOCAL_DB_FILE, { force: true });
  }
});
