/**
 * Bounded undo stack for implemented edits. Each entry records exactly what
 * was written, so undo can verify the text is still there before reverting it
 * (and find it again if the user typed elsewhere in the note meanwhile).
 */
import type { EditStatus, TextRange } from './types';

/** What an Implement wrote into the note. */
export interface WriteRecord {
	/** Where the inserted text starts. */
	from: number;
	removed: string;
	inserted: string;
	/** Up to 30 chars of text just before `from` at write time, to re-find the spot. */
	ctx: string;
}

/** One undoable panel action: an Implement (with its write) or a Skip (write null). */
export interface UndoEntry {
	editId: string;
	/** Status the card had before this action. */
	prevStatus: EditStatus;
	write: WriteRecord | null;
}

export class UndoStack {
	private entries: UndoEntry[] = [];

	constructor(private limit: number) {}

	setLimit(limit: number): void {
		this.limit = Math.max(5, Math.floor(limit));
		while (this.entries.length > this.limit) this.entries.shift();
	}

	push(e: UndoEntry): void {
		this.entries.push(e);
		while (this.entries.length > this.limit) this.entries.shift();
	}

	peek(): UndoEntry | undefined {
		return this.entries[this.entries.length - 1];
	}

	pop(): UndoEntry | undefined {
		return this.entries.pop();
	}

	get size(): number {
		return this.entries.length;
	}

	clear(): void {
		this.entries = [];
	}
}

/**
 * Where to write `entry.removed` back to undo it: the range now holding
 * `entry.inserted`. Checks the recorded spot first, then searches for the
 * context + inserted text nearest to it. Null when the text has changed.
 */
export function revertRange(doc: string, entry: WriteRecord): TextRange | null {
	const { from, inserted, ctx } = entry;
	const at = (p: number): boolean =>
		doc.slice(p, p + inserted.length) === inserted &&
		doc.slice(Math.max(0, p - ctx.length), p) === ctx;
	if (at(from)) return { from, to: from + inserted.length };

	const needle = ctx + inserted;
	if (!needle) return null;
	let bestPos = -1;
	let i = doc.indexOf(needle);
	while (i >= 0) {
		const p = i + ctx.length;
		if (bestPos < 0 || Math.abs(p - from) < Math.abs(bestPos - from)) bestPos = p;
		i = doc.indexOf(needle, i + 1);
	}
	return bestPos >= 0 ? { from: bestPos, to: bestPos + inserted.length } : null;
}
