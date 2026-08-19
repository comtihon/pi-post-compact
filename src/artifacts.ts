import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Directory name, relative to cwd, holding full text displaced by a collapse. */
export const DEFAULT_ARTIFACT_DIRNAME = ".tool_artifacts";

/**
 * On-disk escape hatch for collapsed content.
 *
 * Collapse trades fidelity for tokens, so the original has to remain reachable
 * or the run can strand itself: the model summarizes a file, then needs an exact
 * line from it two turns later. Writing the original to disk first means the
 * stub can name a path the model reads back with its ordinary read/bash tools —
 * no extra tool surface required.
 */
export interface ArtifactStore {
	/** Absolute path an artifact id maps to, whether or not it exists yet. */
	pathFor(id: string): string;
	/** Persist `text`. Returns the path, or `undefined` when the write failed. */
	write(id: string, text: string): string | undefined;
	/** Read an artifact back, or `undefined` when missing/unreadable. */
	read(id: string): string | undefined;
}

/** Strip anything that could escape the artifact directory or confuse a shell. */
export function sanitizeArtifactId(id: string): string {
	return String(id).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function createArtifactStore(
	dir: string,
	onError?: (message: string) => void,
): ArtifactStore {
	const report = onError ?? (() => {});

	const pathFor = (id: string) => join(dir, `${sanitizeArtifactId(id)}.txt`);

	return {
		pathFor,
		write(id, text) {
			const path = pathFor(id);
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(path, text);
				return path;
			} catch (err) {
				report(`artifact write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			}
		},
		read(id) {
			try {
				return readFileSync(pathFor(id), "utf-8");
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * Render the replacement text for collapsed content.
 *
 * The path is included verbatim so recovery needs no special tool — but only
 * when the artifact was actually written, since naming a file that does not
 * exist would send the model chasing it.
 */
export function collapseStub(summary: string, artifactPath?: string): string {
	return artifactPath
		? `[collapsed: ${summary} — full text: ${artifactPath}]`
		: `[collapsed: ${summary}]`;
}
