import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_CONTINUE_PROMPT = "Continue with the previous task. Apply the most useful next step.";

const GROK_BINARY = process.env.GROK_COMPANION_BINARY || "grok";
const READ_ONLY_DENY_RULES = ["Write", "Edit", "Bash"];

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

// With --json-schema, Grok can emit interim JSON objects while it works and the
// schema-valid one last, concatenated in the same text stream. Split them and
// keep the last complete object.
function parseConcatenatedJson(raw) {
  const objects = [];
  let rest = raw.trim();
  while (rest) {
    try {
      objects.push(JSON.parse(rest));
      break;
    } catch (error) {
      // ponytail: relies on V8's "position N" in the error; on mismatch we
      // just return what we parsed so far.
      const match = /position (\d+)/.exec(error.message);
      const position = match ? Number(match[1]) : 0;
      if (!position) {
        break;
      }
      try {
        objects.push(JSON.parse(rest.slice(0, position)));
      } catch {
        break;
      }
      rest = rest.slice(position).trim();
    }
  }
  return objects;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback,
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback,
    };
  } catch (error) {
    const objects = parseConcatenatedJson(rawOutput);
    if (objects.length > 0) {
      return {
        parsed: objects[objects.length - 1],
        parseError: null,
        rawOutput,
        ...fallback,
      };
    }
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback,
    };
  }
}

export function getGrokAvailability(cwd = process.cwd()) {
  const result = spawnSync(GROK_BINARY, ["--version"], { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      version: null,
      detail: result.error?.message ?? (String(result.stderr ?? "").trim() || "grok --version failed."),
    };
  }
  return {
    available: true,
    version: String(result.stdout ?? "").trim() || null,
    detail: null,
  };
}

export async function getGrokAuthStatus() {
  // ponytail: auth.json presence check; real probe would need a network round-trip
  const authPath = path.join(os.homedir(), ".grok", "auth.json");
  const loggedIn = fs.existsSync(authPath);
  return {
    loggedIn,
    detail: loggedIn
      ? `Cached credentials found at ${authPath}.`
      : "No cached Grok credentials. Run `grok` once and sign in.",
  };
}

function reportProgress(onProgress, update) {
  if (typeof onProgress === "function") {
    onProgress(update);
  }
}

function buildTurnArgs(options) {
  const args = ["--output-format", "streaming-json"];
  if (options.resumeThreadId) {
    args.push("--resume", options.resumeThreadId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--reasoning-effort", options.effort);
  }
  if (!options.write) {
    for (const rule of READ_ONLY_DENY_RULES) {
      args.push("--deny", rule);
    }
  }
  if (options.outputSchema) {
    args.push("--json-schema", JSON.stringify(options.outputSchema));
  }
  args.push("--single", options.prompt);
  return args;
}

/**
 * Run one headless Grok turn.
 *
 * @returns {Promise<{status: number, threadId: string|null, turnId: string|null,
 *   finalMessage: string, stderr: string, reasoningSummary: string[],
 *   stopReason: string|null, error: Error|null}>}
 */
export function runGrokTurn(cwd, options = {}) {
  const prompt = String(options.prompt ?? "").trim() || String(options.defaultPrompt ?? "").trim();
  if (!prompt) {
    return Promise.reject(new Error("A prompt is required to run Grok."));
  }

  const args = buildTurnArgs({ ...options, prompt });
  const onProgress = options.onProgress;

  return new Promise((resolve) => {
    const child = spawn(GROK_BINARY, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderr = "";
    let finalMessage = "";
    let reasoning = "";
    let stopReason = null;
    let threadId = options.resumeThreadId ?? null;
    let turnId = null;
    let lastPhase = null;

    reportProgress(onProgress, {
      message: options.resumeThreadId ? `Resuming Grok session ${options.resumeThreadId}.` : "Starting Grok.",
      phase: "starting",
      threadId,
    });

    const handleEvent = (event) => {
      if (event.type === "thought") {
        reasoning += event.data ?? "";
        if (lastPhase !== "reasoning") {
          lastPhase = "reasoning";
          reportProgress(onProgress, { message: "Grok is reasoning.", phase: "reasoning", threadId });
        }
        return;
      }
      if (event.type === "text") {
        finalMessage += event.data ?? "";
        if (lastPhase !== "responding") {
          lastPhase = "responding";
          reportProgress(onProgress, { message: "Grok is responding.", phase: "responding", threadId });
        }
        return;
      }
      if (event.type === "end") {
        stopReason = event.stopReason ?? null;
        threadId = event.sessionId ?? threadId;
        turnId = event.requestId ?? null;
        return;
      }
      // ponytail: unknown event types (tool calls etc.) surfaced as generic progress
      if (event.type && lastPhase !== event.type) {
        lastPhase = event.type;
        reportProgress(onProgress, { message: `Grok event: ${event.type}.`, phase: "working", threadId });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf("\n");
      while (index !== -1) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line) {
          try {
            handleEvent(JSON.parse(line));
          } catch {
            // Non-JSON stdout noise: ignore.
          }
        }
        index = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      resolve({
        status: 1,
        threadId,
        turnId,
        finalMessage,
        stderr: stderr.trim(),
        reasoningSummary: reasoning.trim() ? [reasoning.trim()] : [],
        stopReason,
        error,
      });
    });

    child.on("close", (code) => {
      const trailing = stdoutBuffer.trim();
      if (trailing) {
        stdoutBuffer = "";
        try {
          handleEvent(JSON.parse(trailing));
        } catch {
          // Non-JSON trailing output: ignore.
        }
      }
      const completed = stopReason === "EndTurn" || stopReason === "MaxTokens";
      const status = completed ? 0 : (code ?? 1) || 1;
      resolve({
        status,
        threadId,
        turnId,
        finalMessage,
        stderr: stderr.trim(),
        reasoningSummary: reasoning.trim() ? [reasoning.trim()] : [],
        stopReason,
        error: completed
          ? null
          : new Error(
              stopReason
                ? `Grok turn ended with stop reason "${stopReason}".`
                : `Grok exited with code ${code}.${stderr ? `\n${stderr.trim()}` : ""}`
            ),
      });
    });
  });
}
