// Unit tests for the retroactive-collapse primitives. All pure — no network,
// no filesystem, no LLM.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	CollapseTracker,
	cacheFrontierIndex,
	summarizeToolCallArgs,
	truncateWithNotice,
} from "./collapse.js";

// ── summarizeToolCallArgs ────────────────────────────────────────────────

test("summarizeToolCallArgs: write names the path and the size", () => {
	const args = JSON.stringify({ path: "src/app.ts", content: "x".repeat(5000) });
	const summary = summarizeToolCallArgs("write", args);
	assert.match(summary, /^wrote src\/app\.ts \(\d+ chars\)$/);
	assert.ok(!summary.includes("xxxx"), "payload must not survive into the stub");
});

test("summarizeToolCallArgs: edit counts an array of edits", () => {
	const args = JSON.stringify({ path: "a.py", edits: [{}, {}, {}] });
	assert.equal(summarizeToolCallArgs("edit", args), "edited a.py (3 edit(s))");
});

test("summarizeToolCallArgs: edit counts a JSON-string edits field", () => {
	const args = JSON.stringify({ path: "a.py", edits: JSON.stringify([{}, {}]) });
	assert.equal(summarizeToolCallArgs("edit", args), "edited a.py (2 edit(s))");
});

test("summarizeToolCallArgs: edit with an unparseable edits string falls back to one edit", () => {
	const args = JSON.stringify({ path: "a.py", edits: "not json" });
	assert.equal(summarizeToolCallArgs("edit", args), "edited a.py (1 edit(s))");
});

test("summarizeToolCallArgs: bash keeps the first line and reports a redirect target", () => {
	const args = JSON.stringify({ command: "echo hi > out.txt\nsecond line" });
	const summary = summarizeToolCallArgs("bash", args);
	assert.ok(summary.startsWith("echo hi > out.txt"));
	assert.ok(summary.includes("writes out.txt"));
	assert.ok(!summary.includes("second line"));
});

test("summarizeToolCallArgs: bash reports a heredoc marker when there is no redirect", () => {
	const args = JSON.stringify({ command: "cat <<'EOF'\nbody\nEOF" });
	assert.ok(summarizeToolCallArgs("bash", args).includes("heredoc EOF"));
});

test("summarizeToolCallArgs: bash truncates a very long first line to 80 chars", () => {
	const long = "x".repeat(200);
	const summary = summarizeToolCallArgs("bash", JSON.stringify({ command: long }));
	assert.ok(summary.startsWith("x".repeat(80)));
	assert.ok(!summary.startsWith("x".repeat(81)));
});

test("summarizeToolCallArgs: unknown tool falls back to name plus size", () => {
	assert.equal(summarizeToolCallArgs("mcp", '{"a":1}'), "mcp call, 7 chars");
});

test("summarizeToolCallArgs: unparseable args still report the tool and size", () => {
	assert.equal(summarizeToolCallArgs("write", "{not json"), "write call, 9 chars");
});

test("summarizeToolCallArgs: nullish args are handled without throwing", () => {
	assert.equal(summarizeToolCallArgs("bash", undefined), "bash call, 0 chars");
	assert.equal(summarizeToolCallArgs("bash", null), "bash call, 0 chars");
});

test("summarizeToolCallArgs: a JSON array of args is not treated as an object", () => {
	assert.equal(summarizeToolCallArgs("write", "[1,2,3]"), "write call, 7 chars");
});

// ── truncateWithNotice ───────────────────────────────────────────────────

test("truncateWithNotice: leaves text at or under the ceiling untouched", () => {
	assert.equal(truncateWithNotice("hello", 5), "hello");
	assert.equal(truncateWithNotice("hello", 99), "hello");
});

test("truncateWithNotice: cuts and marks text over the ceiling", () => {
	assert.equal(truncateWithNotice("hello world", 5), "hello…[truncated]");
});

test("truncateWithNotice: a non-positive ceiling disables truncation", () => {
	assert.equal(truncateWithNotice("hello world", 0), "hello world");
});

// ── CollapseTracker ─────────────────────────────────────────────────────

test("CollapseTracker: nothing is due in the round-trip it was tracked in", () => {
	const tracker = new CollapseTracker<string>(0);
	tracker.track("a", "target-a", undefined, 3);
	assert.equal(tracker.due(3).length, 0);
});

test("CollapseTracker: delay 0 becomes due on the next round-trip", () => {
	const tracker = new CollapseTracker<string>(0);
	tracker.track("a", "target-a", undefined, 3);
	const due = tracker.due(4);
	assert.equal(due.length, 1);
	assert.equal(due[0]?.[0], "a");
	assert.equal(due[0]?.[1].target, "target-a");
});

test("CollapseTracker: delay 1 survives one extra round-trip", () => {
	const tracker = new CollapseTracker<string>(1);
	tracker.track("a", "target-a", undefined, 3);
	assert.equal(tracker.due(4).length, 0, "args must not collapse before they execute");
	assert.equal(tracker.due(5).length, 1);
});

test("CollapseTracker: re-tracking an id keeps the original round-trip", () => {
	const tracker = new CollapseTracker<string>(0);
	tracker.track("a", "first", undefined, 1);
	tracker.track("a", "second", undefined, 9);
	const due = tracker.due(2);
	assert.equal(due.length, 1);
	assert.equal(due[0]?.[1].target, "first");
});

test("CollapseTracker: delete removes an entry and size reflects it", () => {
	const tracker = new CollapseTracker<string>(0);
	tracker.track("a", "x", undefined, 1);
	tracker.track("b", "y", undefined, 1);
	assert.equal(tracker.size, 2);
	tracker.delete("a");
	assert.equal(tracker.size, 1);
	assert.deepEqual(tracker.ids(), ["b"]);
});

test("CollapseTracker: due() is a snapshot, so deleting while iterating is safe", () => {
	const tracker = new CollapseTracker<string>(0);
	tracker.track("a", "x", undefined, 1);
	tracker.track("b", "y", undefined, 1);
	for (const [id] of tracker.due(2)) tracker.delete(id);
	assert.equal(tracker.size, 0);
});

test("CollapseTracker: tracksTarget identifies an already-tracked object", () => {
	const tracker = new CollapseTracker<{ n: number }>(0);
	const target = { n: 1 };
	tracker.track("a", target, undefined, 1);
	assert.equal(tracker.tracksTarget(target), true);
	assert.equal(tracker.tracksTarget({ n: 1 }), false, "identity, not equality");
});

test("CollapseTracker: meta rides along with the entry", () => {
	const tracker = new CollapseTracker<string, { reason: string }>(0);
	tracker.track("a", "x", { reason: "find the sort field" }, 1);
	assert.equal(tracker.due(2)[0]?.[1].meta.reason, "find the sort field");
});

// ── cacheFrontierIndex ──────────────────────────────────────────────────

test("cacheFrontierIndex: returns length when nothing is pending", () => {
	const messages = ["a", "b", "c"];
	assert.equal(cacheFrontierIndex(messages, () => false), 3);
});

test("cacheFrontierIndex: returns the index of the first pending message", () => {
	const messages = ["a", "b", "c"];
	assert.equal(
		cacheFrontierIndex(messages, (m) => m === "b"),
		1,
	);
});

test("cacheFrontierIndex: a pending first message makes nothing cacheable", () => {
	assert.equal(
		cacheFrontierIndex(["a", "b"], (m) => m === "a"),
		0,
	);
});

test("cacheFrontierIndex: the predicate receives the index", () => {
	const seen: number[] = [];
	cacheFrontierIndex(["a", "b", "c"], (_m, i) => {
		seen.push(i);
		return false;
	});
	assert.deepEqual(seen, [0, 1, 2]);
});

test("cacheFrontierIndex: an empty message list is cacheable in full", () => {
	assert.equal(cacheFrontierIndex([], () => true), 0);
});
