import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review commands invoke the grok companion and stay review-only", () => {
  for (const file of ["commands/review.md", "commands/adversarial-review.md"]) {
    const source = read(file);
    assert.match(source, /grok-companion\.mjs/);
    assert.doesNotMatch(source, /codex/i);
  }
});

test("expected command files exist and transfer is gone", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command routes through the grok-rescue subagent without forking", () => {
  const rescue = read("commands/rescue.md");
  // Regression for upstream #234: ambiguous routing prose under `context: fork`
  // recursed back into this command. Pin explicit transport, no fork.
  assert.match(rescue, /subagent_type: "grok:grok-rescue"/);
  assert.match(rescue, /do not call `Skill\(grok:grok-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--model <model\|composer>/);
  assert.match(rescue, /--effort <low\|medium\|high>/);
  assert.match(rescue, /If they ask for `composer`, map it to `grok-composer-2\.5-fast`/i);
});

test("rescue agent is a thin forwarder", () => {
  const agent = read("agents/grok-rescue.md");
  assert.match(agent, /name: grok-rescue/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /grok-cli-runtime/);
  assert.doesNotMatch(agent, /codex|gpt-5|spark/i);
});

test("runtime skill matches the headless grok contract", () => {
  const runtimeSkill = read("skills/grok-cli-runtime/SKILL.md");
  assert.match(runtimeSkill, /grok-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(runtimeSkill, /accepted values are `low`, `medium`, `high`/i);
  assert.doesNotMatch(runtimeSkill, /codex|gpt-5|spark/i);
});

test("result handling skill keeps failure discipline", () => {
  const resultHandling = read("skills/grok-result-handling/SKILL.md");
  assert.match(resultHandling, /do not turn a failed or incomplete Grok run into a Claude-side implementation attempt/i);
});

test("hooks expose only the stop review gate", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.doesNotMatch(source, /session-lifecycle-hook/);
});

test("setup command points at the grok companion", () => {
  const setup = read("commands/setup.md");
  assert.match(setup, /grok-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.doesNotMatch(setup, /codex/i);
});

test("no plugin file references codex", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(md|mjs|json)$/.test(entry.name)) {
        if (/codex/i.test(fs.readFileSync(fullPath, "utf8"))) {
          offenders.push(path.relative(PLUGIN_ROOT, fullPath));
        }
      }
    }
  };
  walk(PLUGIN_ROOT);
  assert.deepEqual(offenders, []);
});
