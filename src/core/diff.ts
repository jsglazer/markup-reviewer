/**
 * Narrow an edit to the part that actually changes, so the inline diff shows
 * "very → quite" rather than a whole struck sentence beside a whole new one.
 * The cut is widened to word boundaries so a diff never splits a word.
 */
import type { TextRange } from './types';

export interface Change {
	/** Range within the located span (absolute document offsets). */
	from: number;
	to: number;
	/** Text removed (doc.slice(from, to)). */
	removed: string;
	/** Text inserted in its place. */
	inserted: string;
}

const WORD = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
	return ch !== undefined && WORD.test(ch);
}

/** Common prefix/suffix lengths of a and b, snapped back to word boundaries. */
export function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
	let prefix = 0;
	const max = Math.min(a.length, b.length);
	while (prefix < max && a[prefix] === b[prefix]) prefix++;
	// Don't cut through a word: back off while the cut sits between two word chars.
	while (
		prefix > 0 &&
		isWordChar(a[prefix - 1]) &&
		(isWordChar(a[prefix]) || isWordChar(b[prefix]))
	)
		prefix--;

	let suffix = 0;
	const maxSuffix = max - prefix;
	while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	while (
		suffix > 0 &&
		isWordChar(a[a.length - suffix]) &&
		(isWordChar(a[a.length - suffix - 1]) || isWordChar(b[b.length - suffix - 1]))
	)
		suffix--;
	return { prefix, suffix };
}

/** The minimal change that turns doc[range] into `replacement`. */
export function minimalChange(doc: string, range: TextRange, replacement: string): Change {
	const original = doc.slice(range.from, range.to);
	const { prefix, suffix } = commonEnds(original, replacement);
	return {
		from: range.from + prefix,
		to: range.to - suffix,
		removed: original.slice(prefix, original.length - suffix),
		inserted: replacement.slice(prefix, replacement.length - suffix),
	};
}

/**
 * A pure delete of a word leaves a double space ("a  b") or a space before
 * punctuation ("word ."). Widen the deleted range by one adjacent space when
 * that happens, so the note doesn't need a manual touch-up afterwards.
 */
export function tidyDelete(doc: string, change: Change): Change {
	if (change.inserted !== '' || change.from === change.to) return change;
	const prev = doc[change.from - 1];
	const next = doc[change.to];
	if (prev === ' ' && (next === ' ' || next === undefined || /[.,;:!?)\n]/.test(next))) {
		return { ...change, from: change.from - 1, removed: ' ' + change.removed };
	}
	if (next === ' ' && (prev === undefined || prev === '\n' || prev === '(')) {
		return { ...change, to: change.to + 1, removed: change.removed + ' ' };
	}
	return change;
}
