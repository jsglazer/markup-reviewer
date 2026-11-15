/**
 * Manual edit tracking: compare the note against its original and describe
 * every difference as display marks (additions, deletions, moves). Pure, so
 * the whole pipeline is unit-tested without an editor.
 *
 * The marks are always derived from the two texts, never from a keystroke log,
 * so they survive undo, reloads, crashes and edits made outside Obsidian. The
 * one hint that does come from the editor is the list of recently pasted or
 * dropped texts, which lets short moves and copies show as moves.
 */
import { diffLines, diffWordsWithSpace } from 'diff';
import { bodyStart } from './frontmatter';

/** Text added in the note: [from, to) in the current document. */
export interface AddMark {
	type: 'add';
	from: number;
	to: number;
	/** True when the text was moved or copied here from `origin`. */
	moved: boolean;
	/** Where the moved/copied text came from (offset in the current document). */
	origin?: number;
}

/** Text deleted from the original, shown at `at` in the current document. */
export interface DelMark {
	type: 'del';
	at: number;
	text: string;
	/** True when this deletion is the source of a move (its text reappears at `dest`). */
	moved: boolean;
	dest?: number;
}

/** The source of a copy: unchanged text that was pasted elsewhere (`dest`). */
export interface CopySourceMark {
	type: 'copy-src';
	at: number;
	text: string;
	dest: number;
}

export type TrackMark = AddMark | DelMark | CopySourceMark;

/** Moves/copies of at least this many characters are detected without a paste hint. */
export const MOVE_MIN = 20;

interface Seg {
	kind: 'eq' | 'add' | 'del';
	text: string;
}

/**
 * Word-level diff of one changed block. Whitespace-only runs sandwiched between
 * changes are folded into the change, so "the big red dog" → "a small blue dog"
 * reads as one replacement rather than three.
 */
function wordSegs(a: string, b: string): Seg[] {
	const raw: Seg[] = diffWordsWithSpace(a, b).map((p) => ({
		kind: p.added ? 'add' : p.removed ? 'del' : 'eq',
		text: p.value,
	}));
	for (let i = 1; i < raw.length - 1; i++) {
		const s = raw[i];
		if (s.kind === 'eq' && /^\s+$/.test(s.text) && !/\n/.test(s.text)) {
			if (raw[i - 1].kind !== 'eq' && raw[i + 1].kind !== 'eq') {
				raw.splice(i, 1, { kind: 'del', text: s.text }, { kind: 'add', text: s.text });
				i++;
			}
		}
	}
	// Collapse each run of changes into one deletion followed by one addition.
	const out: Seg[] = [];
	let del = '';
	let add = '';
	const flush = (): void => {
		if (del) out.push({ kind: 'del', text: del });
		if (add) out.push({ kind: 'add', text: add });
		del = add = '';
	};
	for (const s of raw) {
		if (s.kind === 'eq') {
			flush();
			out.push(s);
		} else if (s.kind === 'del') del += s.text;
		else add += s.text;
	}
	flush();
	return out;
}

function norm(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Split a diff part's value into lines, each keeping its trailing newline. */
function splitLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Line diff first (fast on long notes), then a word diff inside each changed
 * block. Whole lines that were moved (deleted in one place, re-added verbatim
 * in another) are pulled out of their blocks first, so a moved line next to an
 * unrelated edit still shows as a move rather than being folded into that
 * edit's word diff.
 */
function segments(a: string, b: string, isMoveKey: (key: string) => boolean): Seg[] {
	const parts = diffLines(a, b);

	// Count the whole lines removed and added anywhere, to pair up moved lines.
	const removedCount = new Map<string, number>();
	const addedCount = new Map<string, number>();
	for (const p of parts) {
		if (!p.added && !p.removed) continue;
		const counts = p.added ? addedCount : removedCount;
		for (const line of splitLines(p.value)) {
			const k = norm(line);
			if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
		}
	}
	const movedBudget = new Map<string, number>();
	for (const [k, n] of removedCount) {
		const m = Math.min(n, addedCount.get(k) ?? 0);
		if (m > 0 && isMoveKey(k)) movedBudget.set(k, m);
	}
	const removedLeft = new Map(movedBudget);
	const addedLeft = new Map(movedBudget);
	const take = (left: Map<string, number>, line: string): boolean => {
		const k = norm(line);
		const n = left.get(k) ?? 0;
		if (n <= 0) return false;
		left.set(k, n - 1);
		return true;
	};

	const out: Seg[] = [];
	let i = 0;
	while (i < parts.length) {
		const p = parts[i];
		if (!p.added && !p.removed) {
			out.push({ kind: 'eq', text: p.value });
			i++;
			continue;
		}
		const removedLines: string[] = [];
		const addedLines: string[] = [];
		while (i < parts.length && (parts[i].added || parts[i].removed)) {
			(parts[i].added ? addedLines : removedLines).push(...splitLines(parts[i].value));
			i++;
		}

		// Moved-away lines become standalone deletions: those before the first
		// unmoved line at the start of the block, the rest at its end.
		let removed = '';
		const trailing: Seg[] = [];
		for (const line of removedLines) {
			if (take(removedLeft, line)) {
				(removed ? trailing : out).push({ kind: 'del', text: line });
			} else removed += line;
		}

		// Added lines in order: moved-in lines stand alone; the first run of other
		// lines is word-diffed against what's left of the removed text.
		let run = '';
		let diffed = false;
		const flushRun = (): void => {
			if (!run) return;
			if (!diffed && removed) out.push(...wordSegs(removed, run));
			else out.push({ kind: 'add', text: run });
			if (removed) diffed = true;
			run = '';
		};
		for (const line of addedLines) {
			if (take(addedLeft, line)) {
				flushRun();
				out.push({ kind: 'add', text: line });
			} else run += line;
		}
		flushRun();
		if (!diffed && removed) out.push({ kind: 'del', text: removed });
		out.push(...trailing);
	}
	return out;
}

/**
 * Every difference between `original` and `current` as marks positioned in
 * `current`. Frontmatter is ignored on both sides, so stamping `pushed:` never
 * shows up as an edit. `pasted` is the list of texts recently pasted or dropped
 * into the note (a hint for detecting short moves and copies).
 */
export function computeMarks(
	original: string,
	current: string,
	pasted: string[] = [],
): TrackMark[] {
	const ob = bodyStart(original);
	const cb = bodyStart(current);
	const a = original.slice(ob);
	const b = current.slice(cb);
	if (a === b) return [];

	const hints = new Set(pasted.map(norm).filter((s) => s.length >= 3));
	const isMoveKey = (key: string): boolean => key.length >= MOVE_MIN || hints.has(key);

	const adds: AddMark[] = [];
	const dels: DelMark[] = [];
	let pos = cb;
	for (const s of segments(a, b, isMoveKey)) {
		if (s.kind === 'eq') pos += s.text.length;
		else if (s.kind === 'del') dels.push({ type: 'del', at: pos, text: s.text, moved: false });
		else {
			adds.push({ type: 'add', from: pos, to: pos + s.text.length, moved: false });
			pos += s.text.length;
		}
	}

	const copies: CopySourceMark[] = [];
	for (const add of adds) {
		const text = current.slice(add.from, add.to);
		const key = norm(text);
		if (!key) continue;
		const hinted = hints.has(key);
		if (key.length < MOVE_MIN && !hinted) continue;

		const del = dels.find((d) => !d.moved && norm(d.text) === key);
		if (del) {
			del.moved = true;
			del.dest = add.from;
			add.moved = true;
			add.origin = del.at;
			continue;
		}
		if (!hinted) continue;
		// A paste of text that is still in the note elsewhere: a copy.
		const needle = text.trim();
		let i = current.indexOf(needle, cb);
		while (i >= 0 && i < add.to && i + needle.length > add.from) i = current.indexOf(needle, i + 1);
		if (i >= 0) {
			add.moved = true;
			add.origin = i;
			copies.push({ type: 'copy-src', at: i, text: needle, dest: add.from });
		}
	}

	return [...dels, ...adds, ...copies].sort((x, y) => markPos(x) - markPos(y));
}

export function markPos(m: TrackMark): number {
	return m.type === 'add' ? m.from : m.at;
}

function words(s: string): number {
	const t = s.trim();
	return t ? t.split(/\s+/).length : 0;
}

export interface TrackStats {
	addedWords: number;
	deletedWords: number;
	moves: number;
}

export function markStats(current: string, marks: TrackMark[]): TrackStats {
	let addedWords = 0;
	let deletedWords = 0;
	let moves = 0;
	for (const m of marks) {
		if (m.type === 'add') {
			if (m.moved) moves++;
			else addedWords += words(current.slice(m.from, m.to));
		} else if (m.type === 'del' && !m.moved) deletedWords += words(m.text);
	}
	return { addedWords, deletedWords, moves };
}

export function describeStats(s: TrackStats): string {
	const parts: string[] = [];
	if (s.addedWords) parts.push(`+${s.addedWords} word${s.addedWords === 1 ? '' : 's'}`);
	if (s.deletedWords) parts.push(`−${s.deletedWords} word${s.deletedWords === 1 ? '' : 's'}`);
	if (s.moves) parts.push(`${s.moves} move${s.moves === 1 ? '' : 's'}`);
	return parts.join(', ') || 'no changes';
}

export interface Excerpt {
	/** 1-based line in the current note where the excerpt starts. */
	line: number;
	/** The passage in CriticMarkup: {++added++}, {--deleted--}, {>>note<<}. */
	text: string;
}

/**
 * The changed passages with some surrounding text, in CriticMarkup. Used for
 * Claude's commit-message prompt and the optional change log.
 */
export function criticExcerpts(current: string, marks: TrackMark[], context = 60): Excerpt[] {
	const shown = marks.filter((m) => m.type !== 'copy-src');
	if (shown.length === 0) return [];
	const end = (m: TrackMark): number => (m.type === 'add' ? m.to : m.at);

	const groups: TrackMark[][] = [];
	for (const m of shown) {
		const g = groups[groups.length - 1];
		if (g && markPos(m) - end(g[g.length - 1]) <= 2 * context) g.push(m);
		else groups.push([m]);
	}

	const out: Excerpt[] = [];
	for (const g of groups) {
		let from = Math.max(0, markPos(g[0]) - context);
		let to = Math.min(current.length, end(g[g.length - 1]) + context);
		// Don't start or stop mid-word, and stay within the surrounding lines.
		while (from > 0 && !/\s/.test(current[from - 1])) from--;
		while (to < current.length && !/\s/.test(current[to])) to++;
		const nlBefore = current.lastIndexOf('\n', markPos(g[0]) - 1);
		if (nlBefore >= from) from = nlBefore + 1;
		const nlAfter = current.indexOf('\n', end(g[g.length - 1]));
		if (nlAfter >= 0 && nlAfter < to) to = nlAfter;

		let text = from > 0 && current[from - 1] !== '\n' ? '…' : '';
		let p = from;
		for (const m of g) {
			const at = markPos(m);
			text += current.slice(p, Math.max(p, at));
			if (m.type === 'del') {
				text += `{--${m.text}--}${m.moved ? '{>>moved<<}' : ''}`;
				p = Math.max(p, at);
			} else if (m.type === 'add') {
				text += `{++${current.slice(m.from, m.to)}++}${m.moved ? '{>>moved here<<}' : ''}`;
				p = Math.max(p, m.to);
			}
		}
		text += current.slice(p, Math.max(p, to));
		if (to < current.length && current[to] !== '\n') text += '…';
		out.push({ line: current.slice(0, from).split('\n').length, text });
	}
	return out;
}
