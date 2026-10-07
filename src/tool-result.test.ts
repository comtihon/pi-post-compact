// Tests for the tool_result pipeline. The summarizer is a fake, so no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArtifactStore } from "./artifacts.js";
import type { CompactOrKeepResult, CompactToolResultOptions } from "./compact.js";
import { readRuntimeConfig } from "./defaults.js";
import { processToolResult } from "./tool-result.js";

function setup(env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pc-tr-"));
	const calls: Array<{ text: string; opts: CompactToolResultOptions }> = [];
	const exact: Array<[string, string]> = [];
	const usage: number[] = [];
	const compact = async (text: string, opts: CompactToolResultOptions): Promise<CompactOrKeepResult> => {
		calls.push({ text, opts });
		return { text: "SUMMARY", changed: true, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
	};
	const deps = {
		config: readRuntimeConfig(env),
		artifacts: createArtifactStore(dir),
		compact,
		onExact: (id: string, reason: string) => exact.push([id, reason]),
		onUsage: (u: { total_tokens: number }) => usage.push(u.total_tokens),
	};
	return { dir, calls, exact, usage, deps };
}

const text = (t: string) => [{ type: "text", text: t }];

test("raw text is written to .tool_artifacts/<toolCallId>.txt by default", async () => {
	const { dir, deps } = setup();
	const out = await processToolResult({ toolCallId: "call_1", toolName: "ls", content: text("a\nb") }, deps);
	assert.equal(out.artifactPath, join(dir, "call_1.txt"));
	assert.equal(readFileSync(join(dir, "call_1.txt"), "utf-8"), "a\nb");
});

test("PI_ARTIFACT_ALL_RESULTS=0 disables the artifact write", async () => {
	const { dir, deps } = setup({ PI_ARTIFACT_ALL_RESULTS: "0" });
	const out = await processToolResult({ toolCallId: "call_1", toolName: "ls", content: text("abc") }, deps);
	assert.equal(out.artifactPath, undefined);
	assert.equal(existsSync(join(dir, "call_1.txt")), false);
});

test("bash results are summarized by default with reason '<tool> output' and the configured style", async () => {
	const { calls, usage, deps, dir } = setup();
	const out = await processToolResult({ toolCallId: "c2", toolName: "bash", content: text("x".repeat(5000)) }, deps);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.opts, { exact: false, reason: "bash output", style: "caveman-one-sentence" });
	assert.equal(out.compacted, true);
	assert.equal(out.content?.[0]?.text, `SUMMARY\n[full output: ${join(dir, "c2.txt")}]`);
	assert.deepEqual(usage, [12]);
});

test("PI_COMPACT_STYLE selects the summary style", async () => {
	const { calls, deps } = setup({ PI_COMPACT_STYLE: "plain" });
	await processToolResult({ toolCallId: "c", toolName: "grep", content: text("hit") }, deps);
	assert.equal(calls[0]?.opts.style, "plain");
});

test("read results are kept verbatim by default and handed to the collapse engine", async () => {
	const { calls, exact, deps } = setup();
	const out = await processToolResult(
		{ toolCallId: "c3", toolName: "read", input: { path: "src/a.ts" }, content: text("file body") },
		deps,
	);
	assert.equal(calls.length, 0);
	assert.equal(out.content, undefined, "unchanged content passes through");
	assert.deepEqual(exact, [["c3", "read output for src/a.ts"]]);
});

test("an explicit directive overrides the default table", async () => {
	const { calls, exact, deps } = setup();
	await processToolResult(
		{ toolCallId: "c4", toolName: "read", content: text("body") },
		{ ...deps, explicitDirective: { exact: false, reason: "find the export" } },
	);
	assert.equal(calls[0]?.opts.reason, "find the export");
	assert.equal(exact.length, 0);

	await processToolResult(
		{ toolCallId: "c5", toolName: "bash", content: text("body") },
		{ ...deps, explicitDirective: { exact: true, reason: "need exact error" } },
	);
	assert.equal(calls.length, 1, "exact:true must not summarize");
	assert.deepEqual(exact, [["c5", "need exact error"]]);
});

test("PI_REQUIRE_DIRECTIVE=1 restores directive-only compaction", async () => {
	const { calls, exact, deps } = setup({ PI_REQUIRE_DIRECTIVE: "1" });
	const out = await processToolResult({ toolCallId: "c6", toolName: "bash", content: text("x".repeat(100)) }, deps);
	assert.equal(calls.length, 0);
	assert.equal(exact.length, 0);
	assert.equal(out.directive, undefined);
	assert.equal(out.content, undefined);
});

test("over-ceiling results are head-truncated with a notice naming the artifact", async () => {
	const { deps, dir } = setup({ PI_REQUIRE_DIRECTIVE: "1", PI_TOOL_RESULT_MAX_CHARS: "100" });
	const body = "H".repeat(100) + "T".repeat(400);
	const out = await processToolResult({ toolCallId: "c7", toolName: "bash", content: text(body) }, deps);
	const result = out.content?.[0]?.text ?? "";
	assert.equal(out.truncated, true);
	assert.ok(result.startsWith("H".repeat(100)));
	assert.ok(!result.includes("T"), "only the head is kept");
	assert.match(result, /showing first 100 of 500 chars/);
	assert.ok(result.includes(join(dir, "c7.txt")), "notice names the artifact path");
	assert.match(result, /read tool/);
	assert.equal(readFileSync(join(dir, "c7.txt"), "utf-8"), body, "artifact holds the untruncated text");
});

test("the default ceiling is 20000 chars and the summarizer sees the truncated text", async () => {
	const { calls, deps } = setup();
	await processToolResult({ toolCallId: "c8", toolName: "bash", content: text("z".repeat(50000)) }, deps);
	const seen = calls[0]?.text ?? "";
	assert.ok(seen.startsWith("z".repeat(20000)));
	assert.ok(!seen.startsWith("z".repeat(20001)));
	assert.match(seen, /showing first 20000 of 50000 chars/);
});

test("truncated exact results are returned truncated", async () => {
	const { deps } = setup({ PI_TOOL_RESULT_MAX_CHARS: "10" });
	const out = await processToolResult({ toolCallId: "c9", toolName: "read", content: text("r".repeat(50)) }, deps);
	assert.ok(out.content?.[0]?.text.startsWith("r".repeat(10) + "\n…[truncated"));
});

test("truncation without an artifact omits the path", async () => {
	const { deps } = setup({ PI_ARTIFACT_ALL_RESULTS: "0", PI_TOOL_RESULT_MAX_CHARS: "10", PI_REQUIRE_DIRECTIVE: "1" });
	const out = await processToolResult({ toolCallId: "c", toolName: "bash", content: text("q".repeat(50)) }, deps);
	assert.equal(out.content?.[0]?.text, `${"q".repeat(10)}\n…[truncated: showing first 10 of 50 chars]`);
});

test("a summary that was not applied leaves the content unchanged", async () => {
	const { deps } = setup();
	const out = await processToolResult(
		{ toolCallId: "c", toolName: "bash", content: text("short") },
		{ ...deps, compact: async (t) => ({ text: t, changed: false, skipped: "below-threshold" }) },
	);
	assert.equal(out.content, undefined);
	assert.equal(out.compacted, false);
});

test("image and mixed results pass through untouched, with no artifact", async () => {
	const { calls, deps, dir } = setup();
	const out = await processToolResult(
		{ toolCallId: "img", toolName: "read", content: [{ type: "text", text: "a" }, { type: "image" }] },
		deps,
	);
	assert.equal(out.content, undefined);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(join(dir, "img.txt")), false);
});
