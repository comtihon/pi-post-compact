// Unit tests for the context-hook collapse engine. No network: `modelRegistry`
// is either omitted (forcing the "unavailable" path) or stubbed to fail auth,
// so `complete()` is never reached. Cases that need a real summary inject one
// through a fake compactor via the engine's public seams.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextCollapseEngine } from "./context-collapse.js";
import { createArtifactStore } from "./artifacts.js";
import type { CompactOrKeepDeps } from "./compact.js";

type Msg = { role?: string } & Record<string, unknown>;

/** Deps that never reach the network: no registry → compaction is "unavailable". */
const inertDeps: CompactOrKeepDeps = { metaLlm: "anthropic/claude-haiku-4-5", modelRegistry: undefined };

/** Deps whose auth always fails, so `complete()` is never called. */
const failingAuthDeps: CompactOrKeepDeps = {
	metaLlm: "anthropic/claude-haiku-4-5",
	modelRegistry: { async getApiKeyAndHeaders() { return { ok: false }; } },
};

const bigText = "y".repeat(4000);

function toolResult(toolCallId: string, text: string): Msg {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }] };
}

function assistantWithToolCall(id: string, name: string, args: Record<string, unknown>, timestamp = 1): Msg {
	return {
		role: "assistant",
		timestamp,
		content: [{ type: "toolCall", id, name, arguments: args }],
	};
}

// ── tool-call argument collapse (no LLM involved) ────────────────────────

test("tool-call args are left intact in the round-trip they appear in", async () => {
	const engine = new ContextCollapseEngine();
	const msg = assistantWithToolCall("tc1", "write", { path: "a.ts", content: bigText });
	await engine.transform([msg], inertDeps);
	const block = (msg.content as Array<Record<string, unknown>>)[0];
	assert.equal((block?.arguments as Record<string, unknown>)?.collapsed, undefined);
});

test("tool-call args survive the round-trip they execute in, then collapse", async () => {
	const engine = new ContextCollapseEngine();
	const msg = assistantWithToolCall("tc1", "write", { path: "a.ts", content: bigText });

	await engine.transform([msg], inertDeps); // round 1: created
	await engine.transform([msg], inertDeps); // round 2: executes — must stay intact
	let args = ((msg.content as Array<Record<string, unknown>>)[0]?.arguments ?? {}) as Record<string, unknown>;
	assert.equal(args.collapsed, undefined, "collapsing here would rewrite args before they run");

	await engine.transform([msg], inertDeps); // round 3: due
	args = ((msg.content as Array<Record<string, unknown>>)[0]?.arguments ?? {}) as Record<string, unknown>;
	assert.equal(args.collapsed, true);
	assert.equal(args.summary, `wrote a.ts (${JSON.stringify({ path: "a.ts", content: bigText }).length} chars)`);
	assert.equal(engine.getStats().collapsedToolCallArgs, 1);
});

test("small tool-call args are never collapsed", async () => {
	const engine = new ContextCollapseEngine();
	const msg = assistantWithToolCall("tc1", "write", { path: "a.ts", content: "tiny" });
	for (let i = 0; i < 4; i++) await engine.transform([msg], inertDeps);
	const args = ((msg.content as Array<Record<string, unknown>>)[0]?.arguments ?? {}) as Record<string, unknown>;
	assert.equal(args.collapsed, undefined);
	assert.equal(engine.getStats().collapsedToolCallArgs, 0);
});

test("collapsed args name an artifact path holding the original", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pc-artifacts-"));
	const engine = new ContextCollapseEngine({ artifacts: createArtifactStore(dir) });
	const original = { path: "a.ts", content: bigText };
    const msg = assistantWithToolCall("tc1", "write", original);

	for (let i = 0; i < 3; i++) await engine.transform([msg], inertDeps);

	const args = ((msg.content as Array<Record<string, unknown>>)[0]?.arguments ?? {}) as Record<string, unknown>;
	assert.equal(typeof args.artifact_path, "string");
	assert.equal(readFileSync(args.artifact_path as string, "utf-8"), JSON.stringify(original));
});

// ── verbatim tool-result collapse ───────────────────────────────────────

test("a tool result with no exact directive is never touched", async () => {
	const engine = new ContextCollapseEngine();
	const msg = toolResult("tr1", bigText);
	for (let i = 0; i < 4; i++) await engine.transform([msg], failingAuthDeps);
	assert.equal((msg.content as Array<Record<string, unknown>>)[0]?.text, bigText);
	assert.equal(engine.getStats().collapsedToolResults, 0);
});

test("an exact result stays verbatim when the summarizer is unavailable", async () => {
	const engine = new ContextCollapseEngine();
	engine.noteExactResult("tr1", "find the sort field");
	const msg = toolResult("tr1", bigText);

	await engine.transform([msg], inertDeps);
	await engine.transform([msg], inertDeps);

	assert.equal((msg.content as Array<Record<string, unknown>>)[0]?.text, bigText, "must never lose data");
	assert.equal(engine.getStats().collapsedToolResults, 0);
});

test("a short exact result is below the threshold and left alone", async () => {
	const engine = new ContextCollapseEngine();
	engine.noteExactResult("tr1", "check the flag");
	const msg = toolResult("tr1", "short");
	for (let i = 0; i < 3; i++) await engine.transform([msg], failingAuthDeps);
	assert.equal((msg.content as Array<Record<string, unknown>>)[0]?.text, "short");
});

test("a tool result carrying an image is skipped entirely", async () => {
	const engine = new ContextCollapseEngine();
	engine.noteExactResult("tr1", "read the chart");
	const msg: Msg = {
		role: "toolResult",
		toolCallId: "tr1",
		content: [{ type: "text", text: bigText }, { type: "image", data: "..." }],
	};
	for (let i = 0; i < 3; i++) await engine.transform([msg], failingAuthDeps);
	assert.equal((msg.content as Array<unknown>).length, 2);
});

// ── hard ceiling ────────────────────────────────────────────────────────

test("the ceiling truncates an oversized verbatim result while it is still in its window", async () => {
	const engine = new ContextCollapseEngine({ maxToolResultChars: 100 });
	engine.noteExactResult("tr1", "find the error");
	const msg = toolResult("tr1", bigText);

	await engine.transform([msg], inertDeps);

	const text = (msg.content as Array<Record<string, unknown>>)[0]?.text as string;
	assert.ok(text.length < bigText.length);
	assert.ok(text.endsWith("…[truncated]"));
	assert.equal(engine.getStats().truncatedToolResults, 1);
});

test("the ceiling is off by default", async () => {
	const engine = new ContextCollapseEngine();
	engine.noteExactResult("tr1", "find the error");
	const msg = toolResult("tr1", bigText);
	await engine.transform([msg], inertDeps);
	assert.equal((msg.content as Array<Record<string, unknown>>)[0]?.text, bigText);
});

// ── assistant content ───────────────────────────────────────────────────

test("large assistant text is not collapsed while the summarizer is unavailable", async () => {
	const engine = new ContextCollapseEngine();
	const msg: Msg = { role: "assistant", timestamp: 7, content: [{ type: "text", text: bigText }] };
	for (let i = 0; i < 4; i++) await engine.transform([msg], inertDeps);
	assert.equal((msg.content as Array<Record<string, unknown>>)[0]?.text, bigText);
	assert.equal(engine.getStats().collapsedAssistantContent, 0);
});

// ── round-trip counting and cache frontier ──────────────────────────────

test("startRun resets the round-trip counter", async () => {
	const engine = new ContextCollapseEngine();
	await engine.transform([], inertDeps);
	await engine.transform([], inertDeps);
	assert.equal(engine.getStats().roundTrip, 2);
	engine.startRun();
	await engine.transform([], inertDeps);
	assert.equal(engine.getStats().roundTrip, 1);
});

test("the cache frontier points at the first message still pending collapse", async () => {
	const engine = new ContextCollapseEngine();
	const stable: Msg = { role: "user", content: "hi" };
	const pending = assistantWithToolCall("tc1", "write", { path: "a.ts", content: bigText });

	await engine.transform([stable, pending], inertDeps);

	assert.equal(engine.getStats().cacheFrontier, 1, "everything before the pending message is cacheable");
	assert.deepEqual(engine.getPendingIds(), ["tc1"]);
});

test("the whole context is cacheable once nothing is pending", async () => {
	const engine = new ContextCollapseEngine();
	const messages: Msg[] = [{ role: "user", content: "hi" }];
	await engine.transform(messages, inertDeps);
	assert.equal(engine.getStats().cacheFrontier, 1);
	assert.deepEqual(engine.getPendingIds(), []);
});

test("transform returns the same array it was given", async () => {
	const engine = new ContextCollapseEngine();
	const messages: Msg[] = [toolResult("tr1", "x")];
	const out = await engine.transform(messages, inertDeps);
	assert.equal(out, messages);
});

test("a malformed message cannot break the turn", async () => {
	const engine = new ContextCollapseEngine();
	const messages: Msg[] = [
		{ role: "toolResult", toolCallId: "tr1", content: "not-an-array" as unknown as never },
		{ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "write" }] },
	];
	const out = await engine.transform(messages, inertDeps);
	assert.equal(out.length, 2);
});
