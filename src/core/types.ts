/**
 * Shared types. Pure: nothing here imports obsidian or CodeMirror, so the core
 * modules can be unit-tested in node.
 */

/** What the pen asked for. */
export type EditKind = 'replace' | 'insert' | 'delete' | 'comment';

export type Ink = 'blue' | 'red' | 'black' | 'other';

export type Confidence = 'high' | 'medium' | 'low';

/** One edit as Claude reads it from the scan (the structured-output shape). */
export interface RawEdit {
	/** 1-based PDF page the mark is on. */
	page: number;
	/** Note line number the mark refers to (render-doc margin number), or null if unknown. */
	line: number | null;
	kind: EditKind;
	/** Exact markdown copied from the note that the edit removes or replaces. Empty for an insert. */
	original: string;
	/** New markdown to put in place of `original`. Empty for a delete; empty for a comment unless Claude drafted text. */
	replacement: string;
	/** Up to ~40 characters of note text immediately before the edit point (for locating it). */
	before: string;
	/** Up to ~40 characters of note text immediately after the edit point. */
	after: string;
	/** Plain-English description of the pen mark, e.g. "Struck 'very' and wrote 'quite' above it". */
	mark: string;
	ink: Ink;
	confidence: Confidence;
}

export interface ReadResult {
	edits: RawEdit[];
	/** Anything Claude could not turn into an edit (illegible marks, general remarks). */
	notes: string;
}

export type EditStatus = 'pending' | 'implemented' | 'skipped';

/** A RawEdit plus review state, as the panel holds it. */
export interface ReviewEdit extends RawEdit {
	id: string;
	status: EditStatus;
	/** The text box's current value (starts as `replacement`). */
	draft: string;
	/** True once "Use selection" re-anchored the edit to text the user picked. */
	reanchored: boolean;
}

export interface TextRange {
	from: number;
	to: number;
}

/** A located edit: the range in the note it replaces (from === to for an insert). */
export interface Located extends TextRange {
	/** How the range was found, shown in the card when it isn't an exact match. */
	how: 'exact' | 'fuzzy' | 'context' | 'line';
}

/** A review session, persisted in plugin data so closing the panel doesn't lose it. */
export interface ReviewSession {
	notePath: string;
	pdfName: string;
	createdAt: string;
	model: string;
	usage: string;
	notes: string;
	edits: ReviewEdit[];
}
