/**
 * Retroactive-collapse primitives.
 *
 * Compaction (see compact.ts) shrinks a tool result *before* the model ever
 * sees it. Collapse is the complement: content the model genuinely needed
 * verbatim is kept verbatim for the turn or two it is actually reasoned over,
 * then replaced by a stub for the rest of the run. Nothing here knows what a
 * message looks like — hosts supply the targets and do the mutation, so the same
 * timing rules serve pi's own `AgentMessage[]` and any provider wire format.
 */

/** Default number of extra round-trips a tracked target rides verbatim. */
export const DEFAULT_COLLAPSE_DELAY = 1;

export interface CollapseEntry<TTarget, TMeta = undefined> {
	target: TTarget;
	/** Round-trip index the target was created in. */
	roundTripCreated: number;
	meta: TMeta;
}

/**
 * Tracks targets awaiting collapse and decides when each becomes due.
 *
 * `delay` is how many *additional* round-trips a target rides verbatim after
 * the one it was created in:
 *
 * - `delay: 0` — collapse as soon as a later round-trip begins. Correct for tool
 *   results, which the model reasons over in the round-trip right after creation.
 * - `delay: 1` — collapse one round-trip later still. Correct for assistant
 *   tool-call arguments and assistant message content: arguments created in
 *   round *r* are executed in *r+1*, so collapsing at *r+1* would rewrite them
 *   before they run; the model has only reasoned over the outcome by *r+2*.
 */
export class CollapseTracker<TTarget, TMeta = undefined> {
	private readonly entries = new Map<string, CollapseEntry<TTarget, TMeta>>();

	constructor(private readonly delay: number = DEFAULT_COLLAPSE_DELAY) {}

	get size(): number {
		return this.entries.size;
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	/** Register a target. Re-tracking an existing id is a no-op, preserving its original round-trip. */
	track(id: string, target: TTarget, meta: TMeta, roundTrip: number): void {
		if (this.entries.has(id)) return;
		this.entries.set(id, { target, roundTripCreated: roundTrip, meta });
	}

	/** True when some tracked entry already points at `target`. */
	tracksTarget(target: TTarget): boolean {
		for (const entry of this.entries.values()) {
			if (entry.target === target) return true;
		}
		return false;
	}

	/**
	 * Entries whose verbatim window has closed by `roundTrip`. Snapshotted, so a
	 * caller may `delete()` while iterating.
	 */
	due(roundTrip: number): Array<[string, CollapseEntry<TTarget, TMeta>]> {
		const out: Array<[string, CollapseEntry<TTarget, TMeta>]> = [];
		for (const [id, entry] of this.entries) {
			if (roundTrip > entry.roundTripCreated + this.delay) out.push([id, entry]);
		}
		return out;
	}

	delete(id: string): void {
		this.entries.delete(id);
	}

	ids(): string[] {
		return [...this.entries.keys()];
	}

	targets(): TTarget[] {
		return [...this.entries.values()].map((e) => e.target);
	}

	clear(): void {
		this.entries.clear();
	}
}

/**
 * Index of the first message still subject to in-place collapse.
 *
 * Everything strictly before it is stable and therefore cacheable by the
 * provider; that message and everything after it may still be rewritten.
 * Returns `messages.length` when nothing is pending.
 *
 * Observability only — it attaches no `cache_control` and alters no request.
 * Retroactive collapse and prompt caching pull against each other: rewriting a
 * message invalidates the provider's cached prefix from that point on, so the
 * collapse delay is what limits the damage. Measure before assuming collapse is
 * a net win on a cache-friendly provider.
 */
export function cacheFrontierIndex<TMessage>(
	messages: readonly TMessage[],
	isPending: (message: TMessage, index: number) => boolean,
): number {
	for (let i = 0; i < messages.length; i++) {
		if (isPending(messages[i] as TMessage, i)) return i;
	}
	return messages.length;
}

/** Truncate `text` to `maxChars`, appending a visible notice when it was cut. */
export function truncateWithNotice(text: string, maxChars: number, notice = "…[truncated]"): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	return text.slice(0, maxChars) + notice;
}

/**
 * One-line description of an assistant tool call's arguments, used as the stub
 * that replaces them once the call has run.
 *
 * Purely lexical — no LLM — because the interesting part of a large argument
 * blob is almost always the target and the size, not the payload: a `write` is
 * identified by its path, a `bash` by its first line plus any redirect target.
 */
export function summarizeToolCallArgs(fnName: string, argsString: unknown): string {
	const raw = String(argsString ?? "");
	const chars = raw.length;

	let args: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = JSON.parse(raw);
		args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		args = null;
	}

	const path = typeof args?.path === "string" ? args.path : undefined;

	if (fnName === "write" && path) return `wrote ${path} (${chars} chars)`;

	if (fnName === "edit" && path) {
		let n = 1;
		const edits = args?.edits;
		if (Array.isArray(edits)) {
			n = edits.length;
		} else if (typeof edits === "string") {
			try {
				const parsed: unknown = JSON.parse(edits);
				if (Array.isArray(parsed)) n = parsed.length;
			} catch {
				// keep n = 1
			}
		}
		return `edited ${path} (${n} edit(s))`;
	}

	if (fnName === "bash" && typeof args?.command === "string") {
		const command = args.command;
		const first = command.split("\n")[0]?.slice(0, 80) ?? "";
		let target = "";
		const redirect = command.match(/>{1,2}\s*(\S+)/);
		if (redirect) {
			target = `, writes ${redirect[1]}`;
		} else {
			const heredoc = command.match(/<<\s*['"]?(\w+)/);
			if (heredoc) target = `, heredoc ${heredoc[1]}`;
		}
		return `${first}${target}, ${chars} chars total`;
	}

	return `${fnName} call, ${chars} chars`;
}
