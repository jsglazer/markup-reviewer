/**
 * Minimal, format-preserving YAML frontmatter helpers. Only the one line that
 * holds the field is touched, so every other line of the note's frontmatter
 * (quoting, empty values, order) stays exactly as the user wrote it.
 */

export interface FrontmatterRange {
	/** Offset where the closing `---` line starts. */
	closeStart: number;
	/** Offset just past the closing line (where the body starts). */
	end: number;
}

/** The frontmatter block's extent, or null when the note has none. */
export function frontmatterRange(text: string): FrontmatterRange | null {
	const open = /^---[ \t]*\r?\n/.exec(text);
	if (!open) return null;
	const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
	close.lastIndex = open[0].length;
	const m = close.exec(text);
	if (!m) return null;
	return { closeStart: m.index, end: m.index + m[0].length };
}

/** Offset where the note body starts (0 when there is no frontmatter). */
export function bodyStart(text: string): number {
	return frontmatterRange(text)?.end ?? 0;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldLine(key: string): RegExp {
	return new RegExp(`^${escapeRe(key)}:[ \\t]*(.*?)[ \\t]*$`, 'm');
}

/** A top-level scalar field's value (quotes stripped), '' when empty, null when absent. */
export function getField(text: string, key: string): string | null {
	const range = frontmatterRange(text);
	if (!range) return null;
	const m = fieldLine(key).exec(text.slice(0, range.closeStart));
	if (!m) return null;
	const v = m[1];
	if (
		v.length >= 2 &&
		((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
	)
		return v.slice(1, -1);
	return v;
}

/** Set (or add) a top-level field, creating the frontmatter block if the note has none. */
export function setField(text: string, key: string, value: string): string {
	const line = value === '' ? `${key}:` : `${key}: ${value}`;
	const range = frontmatterRange(text);
	if (!range) return `---\n${line}\n---\n${text}`;
	const head = text.slice(0, range.closeStart);
	const re = fieldLine(key);
	const m = re.exec(head);
	if (m) return text.slice(0, m.index) + line + text.slice(m.index + m[0].length);
	return `${head}${line}\n${text.slice(range.closeStart)}`;
}
