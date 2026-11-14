/**
 * Locate an edit in the note's current text. Edits are re-located every time
 * they are previewed or implemented, so earlier edits that shifted the text
 * never leave a stale offset behind.
 *
 * Strategy, best first:
 *   exact    — `original` occurs verbatim; ties broken by before/after context, then by
 *              distance from the hinted line.
 *   fuzzy    — `original` matches with any run of whitespace standing for any other.
 *   context  — `original` not found, but `before` … `after` bracket a span on one line.
 *   line     — nothing matched; fall back to the end of the hinted line (inserts only).
 */
import type { Located, RawEdit } from './types';

type Anchorable = Pick<RawEdit, 'original' | 'before' | 'after' | 'line'>;

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex source matching `s` with every whitespace run loosened to \s+. */
function looseSource(s: string): string {
	return s.trim().split(/\s+/).filter(Boolean).map(escapeRe).join('\\s+');
}

function lineOf(doc: string, offset: number): number {
	let n = 1;
	for (let i = 0; i < offset && i < doc.length; i++) if (doc.charCodeAt(i) === 10) n++;
	return n;
}

/** Offset of the end of 1-based line `line` (clamped to the document). */
export function lineEndOffset(doc: string, line: number): number {
	let n = 1;
	for (let i = 0; i < doc.length; i++) {
		if (doc.charCodeAt(i) === 10) {
			if (n === line) return i;
			n++;
		}
	}
	return doc.length;
}

interface Candidate {
	from: number;
	to: number;
}

function allExact(doc: string, needle: string): Candidate[] {
	const out: Candidate[] = [];
	if (!needle) return out;
	let i = doc.indexOf(needle);
	while (i >= 0) {
		out.push({ from: i, to: i + needle.length });
		i = doc.indexOf(needle, i + 1);
	}
	return out;
}

function allLoose(doc: string, needle: string): Candidate[] {
	const src = looseSource(needle);
	if (!src) return [];
	const re = new RegExp(src, 'g');
	const out: Candidate[] = [];
	for (const m of doc.matchAll(re)) {
		if (m.index === undefined) continue;
		out.push({ from: m.index, to: m.index + m[0].length });
	}
	return out;
}

/** Whitespace-insensitive "does the text just before `from` end with `ctx`". */
function precededBy(doc: string, from: number, ctx: string): boolean {
	const c = ctx.replace(/\s+/g, ' ').trim();
	if (!c) return false;
	const window = doc
		.slice(Math.max(0, from - ctx.length - 20), from)
		.replace(/\s+/g, ' ')
		.trimEnd();
	return window.endsWith(c);
}

function followedBy(doc: string, to: number, ctx: string): boolean {
	const c = ctx.replace(/\s+/g, ' ').trim();
	if (!c) return false;
	const window = doc
		.slice(to, to + ctx.length + 20)
		.replace(/\s+/g, ' ')
		.trimStart();
	return window.startsWith(c);
}

function best(doc: string, cands: Candidate[], edit: Anchorable): Candidate | null {
	if (cands.length === 0) return null;
	if (cands.length === 1) return cands[0];
	let top: Candidate | null = null;
	let topScore = -Infinity;
	for (const c of cands) {
		let score = 0;
		if (precededBy(doc, c.from, edit.before)) score += 1000;
		if (followedBy(doc, c.to, edit.after)) score += 1000;
		if (edit.line !== null) score -= Math.abs(lineOf(doc, c.from) - edit.line);
		if (score > topScore) {
			top = c;
			topScore = score;
		}
	}
	return top;
}

/** Find the insertion point for an edit with no `original`. */
function locatePoint(doc: string, edit: Anchorable): Located | null {
	const { before, after } = edit;
	if (before && after) {
		const both = best(doc, allExact(doc, `${before}${after}`), edit);
		if (both) {
			const p = both.from + before.length;
			return { from: p, to: p, how: 'exact' };
		}
	}
	if (before) {
		const c = best(doc, allExact(doc, before), edit) ?? best(doc, allLoose(doc, before), edit);
		if (c) return { from: c.to, to: c.to, how: 'context' };
	}
	if (after) {
		const c = best(doc, allExact(doc, after), edit) ?? best(doc, allLoose(doc, after), edit);
		if (c) return { from: c.from, to: c.from, how: 'context' };
	}
	if (edit.line !== null) {
		const p = lineEndOffset(doc, edit.line);
		return { from: p, to: p, how: 'line' };
	}
	return null;
}

/** Locate `edit` in `doc`, or null when there is nothing to go on. */
export function locate(doc: string, edit: Anchorable): Located | null {
	if (!edit.original) return locatePoint(doc, edit);

	const exact = best(doc, allExact(doc, edit.original), edit);
	if (exact) return { ...exact, how: 'exact' };

	const loose = best(doc, allLoose(doc, edit.original), edit);
	if (loose) return { ...loose, how: 'fuzzy' };

	// Bracketed by context on one line: take what lies between.
	if (edit.before && edit.after) {
		const re = new RegExp(
			`(${looseSource(edit.before)})(\\s*)([^\\n]*?)(\\s*)(${looseSource(edit.after)})`,
			'g',
		);
		const cands: Candidate[] = [];
		for (const m of doc.matchAll(re)) {
			if (m.index === undefined) continue;
			const from = m.index + m[1].length + m[2].length;
			cands.push({ from, to: from + m[3].length });
		}
		const c = best(doc, cands, edit);
		if (c) return { ...c, how: 'context' };
	}
	return null;
}
