# pi-post-compact

Context-reduction extension for the [pi coding agent](https://github.com/earendil-works/pi).

A long agent run spends most of its tokens re-sending old tool output. This extension cuts that
down in two complementary ways, and exposes the same machinery as a library so a host driving its
own provider loop can reuse it — see [Library API](#library-api).

- **Compaction** — shrink a tool result *before* the model ever sees it.
- **Collapse** — keep content the model genuinely needed verbatim, then replace it with a stub once
  it has actually been reasoned over.

Install it like any pi extension; both mechanisms are on by default.

---

## Compaction

Every text-only tool result passes through the `tool_result` hook, in this order:

1. **Artifact** — the raw, untruncated text is written to `<cwd>/.tool_artifacts/<toolCallId>.txt`
   (`PI_ARTIFACT_ALL_RESULTS`, on by default). This is the escape hatch for everything below.
2. **Hard ceiling** — text longer than `PI_TOOL_RESULT_MAX_CHARS` (default `20000`) is cut to its
   head, with a notice naming the artifact path so the model can `read` the rest:
   ```
   …[truncated: showing first 20000 of 81234 chars — full output saved to /work/.tool_artifacts/call_7.txt; use the read tool on that path if you need the rest]
   ```
3. **Directive** — an explicit `post_compact` argument from the model wins; otherwise a default
   table decides (`src/defaults.ts`):

   | Tool | Default |
   |---|---|
   | `read`, `write`, `edit`, `multiedit` | `exact` — kept verbatim, then collapsed after one use (see [Collapse](#collapse)) |
   | `bash`, `grep`, `find`, `ls`, `mcp`, and any other tool | summarize, with reason `"<tool> output"` |

   `PI_REQUIRE_DIRECTIVE=1` restores the old directive-only behaviour: no `post_compact`, no
   summarizing (steps 1–2 still apply), and the system prompt makes the directive mandatory again.
4. **Summarize** — non-exact results go through `compactOrKeep` with style `PI_COMPACT_STYLE`
   (default `caveman-one-sentence`) and floor `PI_COMPACT_MIN_CHARS`. A summary that replaces a
   result is followed by `[full output: <artifact path>]`.

The directive the model can supply:

```jsonc
post_compact: {
  exact: false,                                  // summarize the result
  reason: "looking for authentication entry points"
}
```

`reason` is the summarizer's focus string — a summary with a stated target keeps the part that
mattered; the default `"<tool> output"` reason is the fallback, not the ideal.

### Advertising the directive in tool schemas

The system prompt alone is a weak signal, so a `before_provider_request` handler
(`PI_SCHEMA_DIRECTIVE`, on by default) adds an optional `post_compact: {exact, reason}` property to
every tool schema in the outgoing payload. It handles the openai-completions
(`tools[].function.parameters`), openai-responses (`tools[].parameters`) and anthropic
(`tools[].input_schema`) shapes; is idempotent; leaves an existing `post_compact` property alone;
never adds it to `required`; skips `strict: true` tools; and clones each schema rather than
mutating it (pi passes its own tool schema objects through by reference).

**Validation.** pi validates tool arguments (`validateToolArguments` in pi-ai, called from the
agent loop's `prepareToolCall`) *before* the `tool_call` extension hook runs. Most built-in tool
schemas are TypeBox objects without `additionalProperties: false`, so an extra argument passes —
but `edit`'s schema sets `additionalProperties: false`, so `edit` with `post_compact` would fail
validation. The extension therefore strips `post_compact` (recording the directive by tool-call
id) in a `message_end` handler: the agent loop awaits `message_end` for the assistant message
before preparing its tool calls, and executes from that same message object, so the stripped
arguments are what gets validated and executed. The `tool_call` handler strips it as well, as a
fallback.

Guard rails, all of which fail toward keeping your data:

| Situation | Behavior |
|---|---|
| Result shorter than the threshold | kept raw — not worth an extra LLM round-trip |
| Summary is not shorter than the input | discarded, raw kept (routine on terse output like `ls`) |
| Meta-LLM unreachable, unauthorized, or erroring | kept raw, run continues |
| Result contains an image, or mixes text and non-text | skipped entirely (no artifact, no truncation) |

`compactToolResult` never throws. A failure degrades the optimization; it does not break the agent.

## Collapse

`exact` results (explicit, or by default for file tools) are deliberately *not* compacted. Instead
they ride verbatim for exactly as long as they are useful, then get replaced.

This runs on the `context` hook, which fires before every LLM call and receives a **deep copy** of
the message list. That matters: only the outgoing payload shrinks. Session history, `/compact`,
resume, and the transcript all keep full fidelity.

What gets collapsed, and when:

| Target | Rides verbatim for | Replaced by |
|---|---|---|
| `exact` tool result | the round-trip it was created in | one-sentence *finding* — what you learned, not what the output contained |
| Assistant tool-call arguments over `PI_ARG_COLLAPSE_MIN_CHARS` (strict `>`) | two round-trips | lexical stub (`wrote src/app.ts (5021 chars)`) — no LLM call |
| Large assistant text | two round-trips | one-sentence summary preserving decisions, findings, and paths |

The two-round-trip delay on tool-call arguments is not a tuning choice. Arguments created in round
*r* are executed in *r+1*, so rewriting them any earlier would change what actually runs.

The *finding* framing is where most of the compression comes from: `exact: false` answers "what does
this contain", while a collapsed verbatim result answers "what did I learn" — `sort_key found on
line 42` instead of a paragraph describing the file.

### Recovering collapsed content

Collapse trades fidelity for tokens, so the original is written to `.tool_artifacts/` first and the
stub names the path:

```
[collapsed: sort_key found on line 42 — full text: /workspace/.tool_artifacts/tc_17-result.txt]
```

Reading it back needs no special tool — the model uses its ordinary `read` or `bash`. When the write
fails, the stub omits the path rather than pointing at a file that isn't there.

### Prompt caching

Rewriting history invalidates the provider's cached prefix from the first rewritten message onward.
The collapse delay limits the blast radius, and `cacheFrontierIndex` reports where the stable prefix
ends (logged once per context transform when `PI_POST_COMPACT_DEBUG=1` — pi gives extensions no
logger, so debug lines go to stderr), but the tension is real: on a provider you rely on for prompt
caching, **measure before assuming collapse is a net win**. Disable it with `--no_context_collapse`.

---

## Configuration

| Setting | Default | Effect |
|---|---|---|
| `--meta_llm` flag | — | Model used for summaries, as `provider/model` |
| `META_LLM_PROVIDER` + `META_LLM_MODEL` | — | Same, for hosts that configure via env |
| `.pi/post-compact.json` → `meta_llm` | — | Same, per project |
| *(fallback)* | `anthropic/claude-haiku-4-5` | Used when none of the above is set |
| `--no_context_collapse` flag | off | Disable collapse; compaction stays on |
| `PI_ARTIFACT_ALL_RESULTS` | `1` (on) | Write every text tool result to `<cwd>/.tool_artifacts/<toolCallId>.txt` |
| `PI_TOOL_RESULT_MAX_CHARS` | `20000` | Hard head-truncation ceiling on tool-result text; `0` disables |
| `PI_REQUIRE_DIRECTIVE` | `0` (off) | `1` = only summarize when the model supplied `post_compact` (pre-defaults behaviour) |
| `PI_COMPACT_STYLE` | `caveman-one-sentence` | Summary style: `plain`, `caveman`, `one-sentence`, `caveman-one-sentence` |
| `PI_COMPACT_MIN_CHARS` | `800` | Floor below which a tool result is not summarized |
| `PI_COLLAPSE_MIN_CHARS` | `800` | Floor below which verbatim results / assistant text are not collapsed |
| `PI_ARG_COLLAPSE_MIN_CHARS` | `800` | Tool-call arguments are collapsed only when their JSON is strictly longer |
| `PI_SCHEMA_DIRECTIVE` | `1` (on) | Add the optional `post_compact` property to outgoing tool schemas |
| `PI_POST_COMPACT_DEBUG` | `0` (off) | Debug lines on stderr (cache frontier per context transform) |

Booleans accept `1/true/yes/on` and `0/false/no/off`; invalid values fall back to the default.

Precedence for the meta-LLM is flag → env pair → project config → default.

## Observability

At `agent_end` the extension emits `post-compact:stats` on `pi.events`:

```ts
pi.events.on("post-compact:stats", (data) => {
  const { collapseStats, metaUsage } = data as PostCompactStatsEvent;
  // collapseStats: ContextCollapseStats (session-cumulative counters, cacheFrontier, …)
  // metaUsage:     { prompt_tokens, completion_tokens, total_tokens } spent by the meta-LLM
  //                during this agent run (tool-result compaction + context collapse)
});
```

## Known limitation: usage accounting

Meta-LLM tokens spent on summarizing are **invisible to pi's session stats**. The SDK's
`ExtensionAPI` / `ExtensionContext` surface exposes no way for an extension to report supplementary
usage — `getContextUsage()` is read-only, and there is no `addUsage`-style call. This is a hard SDK
limitation, not an oversight.

The `post-compact:stats` event above is the workaround: a host can listen on `pi.events` and add
`metaUsage` to its own accounting. A host that intercepts provider HTTP itself can also read `usage`
off the `compactOrKeep` result directly. [pi-cloud-agent](https://github.com/comtihon/pi-cloud-agent)
currently does this, tracking meta-LLM cost separately from the agent's own token usage.

## Migrating from pi-cloud-agent's interceptor

pi-cloud-agent's `globalThis.fetch` interceptor (`src/runner.js`, the resolver loop) duplicated
these optimisations for its own hand-rolled tool loop. With them in this extension, a host running
pi's native agent loop (plus pi-mcp-adapter's proxy `mcp` tool) gets them without the interceptor.

**Covered here now**

| runner.js behaviour | Here |
|---|---|
| Raw tool output written to `.tool_artifacts/<id>.txt` for every call | `PI_ARTIFACT_ALL_RESULTS` (artifacts land in `<cwd>/.tool_artifacts`, not a hard-coded `/workspace`) |
| `MCP_TOOL_RESULT_MAX_CHARS` head truncation (20000) with a pointer to the artifact | `PI_TOOL_RESULT_MAX_CHARS` (20000); the notice names a file path for `read` instead of a `read_artifact` id |
| Per-tool `exact` defaults (read/write/edit verbatim, everything else summarized), explicit `reason`/`exact` wins | default directive table + explicit `post_compact` |
| `_maybeCompact` with `style: 'caveman-one-sentence'` and `MCP_COMPACT_MIN_CHARS` | `PI_COMPACT_STYLE`, `PI_COMPACT_MIN_CHARS` |
| exact results collapsed to an action summary after one use | collapse engine (unchanged) |
| `MCP_ARG_COLLAPSE_MIN_CHARS` (800, strict `>`) tool-call argument collapse | `PI_ARG_COLLAPSE_MIN_CHARS` |
| Large assistant content collapse | collapse engine (unchanged; uses `PI_COLLAPSE_MIN_CHARS`) |
| `reason`/`exact` properties injected into tool schemas | `post_compact` property via `PI_SCHEMA_DIRECTIVE`, on all tools and three payload shapes |
| `cache frontier` log line | `PI_POST_COMPACT_DEBUG=1` |
| `_metaUsageAcc` meta-LLM usage accumulator | `metaUsage` on the `post-compact:stats` event |

**Intentionally not here**

- **kimi-k2 first-turn `tool_choice` forcing and `stream: false` retries.** Retrying means
  re-issuing the provider request when the model ignores `tool_choice`, which an extension cannot
  do. At most a tiny `before_provider_request` extension can set `tool_choice: "required"` on the
  first request, with no retry.
- **The custom resolver loop and tool stripping.** Unnecessary with pi's native agent loop and
  pi-mcp-adapter's proxy tool — pi executes every registered tool itself.
- **MCP tool-list pre-warm and the proxy `mcp` schema.** These belong in pi-mcp-adapter.
- **Final-JSON nudges and the forced `tool_choice: "none"` summary.** Host/carrier logic, to run
  after `session.prompt()` returns.
- **Meta-LLM usage in session stats.** Needs a pi core API (see above); the stats event is the
  stand-in.
- **`contextWindow` / `maxTokens`.** Model configuration belongs in the carrier's `agent_config`.

---

## Library API

Everything above is also importable, so a host running its own provider loop — one that never passes
through pi's agent loop, and so never reaches the `context` hook — can apply the same policy instead
of reimplementing it. Nothing in the core knows what a message looks like; hosts supply the targets
and perform the mutation.

```ts
import {
  compactOrKeep,             // gate + summarize + no-shrink guard, never throws
  compactToolResult,         // the raw meta-LLM summarization call
  resolveMetaLlm,            // flag → env → project config → default
  CollapseTracker,           // "is this target due for collapse yet" timing rules
  cacheFrontierIndex,        // first message still subject to rewriting
  summarizeToolCallArgs,     // lexical stub for large tool-call arguments
  truncateWithNotice,        // hard ceiling
  createArtifactStore,       // on-disk escape hatch for displaced originals
  collapseStub,              // stub text, with the artifact path when available
  buildActionSummaryInstruction,  // the "what did I learn" prompt
  ContextCollapseEngine,     // the whole collapse pass over pi's AgentMessage[]
  processToolResult,         // the tool_result pipeline (artifact → ceiling → directive → summarize)
  resolveDirective,          // explicit post_compact → default table
  readRuntimeConfig,         // all PI_* env settings with their defaults
  injectPostCompactSchema,   // add post_compact to tool schemas in a provider payload
} from "pi-post-compact";
```

Summary style is a first-class option (`style: "caveman-one-sentence"` and friends) rather than
something callers concatenate onto `reason`, which keeps *what to look for* separate from *how to
write it*.

```bash
npm run build    # tsc
npm test         # tsc, then node --test over dist (needs Node 22+)
```

## License

MIT
