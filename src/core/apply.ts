/**
 * Turn a review edit plus the note's current text into the concrete change to
 * write (or preview). Pure, so the whole locate → narrow → tidy pipeline is
 * unit-tested without an editor.
 */
import { locate } from './anchor';
import { minimalChange, tidyDelete, type Change } from './diff';
import type { Located, RawEdit } from './types';

export interface Plan {
	located: Located;
	change: Change;
}

/** Null when the edit can't be found in `doc`. `text` is the card's (possibly edited) text box. */
export function planChange(
	doc: string,
	edit: Pick<RawEdit, 'original' | 'before' | 'after' | 'line'>,
	text: string,
): Plan | null {
	const located = locate(doc, edit);
	if (!located) return null;
	let change = minimalChange(doc, located, text);
	if (change.inserted === '') change = tidyDelete(doc, change);
	return { located, change };
}

const CONTEXT = 30;

/**
 * Re-anchor an edit on what the user selected in the editor: the selection
 * becomes `original` (empty for a bare cursor, i.e. an insertion point) and
 * the text around it becomes the before/after context.
 */
export function anchorFromSelection(
	doc: string,
	from: number,
	to: number,
): Pick<RawEdit, 'original' | 'before' | 'after' | 'line'> {
	const a = Math.max(0, Math.min(from, to));
	const b = Math.min(doc.length, Math.max(from, to));
	const lineStart = doc.lastIndexOf('\n', a - 1) + 1;
	const nl = doc.indexOf('\n', b);
	const lineEnd = nl < 0 ? doc.length : nl;
	return {
		original: doc.slice(a, b),
		before: doc.slice(Math.max(lineStart, a - CONTEXT), a),
		after: doc.slice(b, Math.min(lineEnd, b + CONTEXT)),
		line: doc.slice(0, a).split('\n').length,
	};
}
