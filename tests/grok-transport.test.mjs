import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeFakeGrok(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-grok-"));
  const binPath = path.join(dir, "grok");
  fs.writeFileSync(binPath, script);
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

const STREAMING_FAKE = `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ type: "thought", data: "thinking about it" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", data: "ARGS:" + JSON.stringify(args) }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-123", requestId: "req-456" }) + "\\n");
`;

async function loadTransport(fakeBinary) {
  process.env.GROK_COMPANION_BINARY = fakeBinary;
  // Cache-bust so GROK_BINARY is re-read from env.
  const module = await import(
    `${path.join(ROOT, "plugins", "grok", "scripts", "lib", "grok.mjs")}?t=${Date.now()}-${Math.random()}`
  );
  return module;
}

test("runGrokTurn parses streaming-json and builds read-only args", async () => {
  const { runGrokTurn } = await loadTransport(makeFakeGrok(STREAMING_FAKE));
  const phases = [];
  const result = await runGrokTurn(process.cwd(), {
    prompt: "do the thing",
    model: "grok-4.5",
    effort: "high",
    write: false,
    onProgress: (update) => phases.push(update.phase)
  });

  assert.equal(result.status, 0);
  assert.equal(result.threadId, "sess-123");
  assert.equal(result.turnId, "req-456");
  assert.equal(result.stopReason, "EndTurn");
  assert.deepEqual(result.reasoningSummary, ["thinking about it"]);
  assert.equal(result.error, null);
  assert.ok(phases.includes("starting"));
  assert.ok(phases.includes("reasoning"));
  assert.ok(phases.includes("responding"));

  const args = JSON.parse(result.finalMessage.replace("ARGS:", ""));
  assert.deepEqual(args.slice(0, 2), ["--output-format", "streaming-json"]);
  assert.ok(args.includes("--model") && args.includes("grok-4.5"));
  assert.ok(args.includes("--reasoning-effort") && args.includes("high"));
  for (const rule of ["Write", "Edit", "Bash"]) {
    assert.ok(args.includes(rule), `read-only run must deny ${rule}`);
  }
  assert.equal(args[args.length - 1], "do the thing");
});

test("runGrokTurn write mode resumes without deny rules", async () => {
  const { runGrokTurn } = await loadTransport(makeFakeGrok(STREAMING_FAKE));
  const result = await runGrokTurn(process.cwd(), {
    prompt: "continue",
    resumeThreadId: "sess-prev",
    write: true
  });

  const args = JSON.parse(result.finalMessage.replace("ARGS:", ""));
  assert.ok(args.includes("--resume") && args.includes("sess-prev"));
  assert.ok(!args.includes("--deny"), "write run must not carry deny rules");
});

test("runGrokTurn surfaces failures when no end event arrives", async () => {
  const fake = makeFakeGrok(`#!/usr/bin/env node
process.stderr.write("boom\\n");
process.exit(3);
`);
  const { runGrokTurn } = await loadTransport(fake);
  const result = await runGrokTurn(process.cwd(), { prompt: "explode" });

  assert.equal(result.status, 3);
  assert.match(result.error.message, /exited with code 3/);
  assert.match(result.stderr, /boom/);
});

test("parseStructuredOutput keeps the last object from concatenated JSON", async () => {
  const { parseStructuredOutput } = await import(
    `${path.join(ROOT, "plugins", "grok", "scripts", "lib", "grok.mjs")}?t=parse-${Math.random()}`
  );
  const raw = '{"verdict":"interim","findings":[]}{"verdict":"needs-attention","findings":[{"title":"x"}]}';
  const result = parseStructuredOutput(raw);
  assert.equal(result.parseError, null);
  assert.equal(result.parsed.verdict, "needs-attention");
  assert.equal(result.parsed.findings.length, 1);

  const single = parseStructuredOutput('{"verdict":"clean"}');
  assert.equal(single.parsed.verdict, "clean");

  const garbage = parseStructuredOutput("not json at all");
  assert.equal(garbage.parsed, null);
  assert.ok(garbage.parseError);
});
