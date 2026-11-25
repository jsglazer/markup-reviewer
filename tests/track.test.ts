import { describe, expect, it } from 'vitest';
import { bodyStart, getField, setField } from '../src/core/frontmatter';
import {
	contentsUrl,
	isSidecar,
	parseRepo,
	pushedStamp,
	repoFilePath,
	sidecarPath,
	submitTagName,
} from '../src/core/repo';
import {
	computeMarks,
	criticExcerpts,
	describeStats,
	markStats,
	type AddMark,
	type DelMark,
	type TrackMark,
} from '../src/core/track';

const FM =
	'---\ntitle: Paper\ngit: Classes/2026-B/RD - POGO 801/Assign/Final/\npushed: \ndate:\n---\n';

describe('frontmatter', () => {
	it('finds the body start', () => {
		expect(bodyStart(`${FM}Body`)).toBe(FM.length);
		expect(bodyStart('No frontmatter')).toBe(0);
		expect(bodyStart('---\nunterminated')).toBe(0);
	});

	it('reads fields, empty and absent', () => {
		expect(getField(FM, 'git')).toBe('Classes/2026-B/RD - POGO 801/Assign/Final/');
		expect(getField(FM, 'pushed')).toBe('');
		expect(getField(FM, 'author')).toBeNull();
		expect(getField('---\na: "quoted"\n---\n', 'a')).toBe('quoted');
		expect(getField('Body only\ngit: x', 'git')).toBeNull();
	});

	it('sets a field touching only its line', () => {
		const out = setField(`${FM}Body`, 'pushed', '20261115-153000');
		expect(out).toBe(FM.replace('pushed: \n', 'pushed: 20261115-153000\n') + 'Body');
		expect(out).toContain('date:\n');
	});

	it('adds a missing field before the closing line', () => {
		expect(setField('---\na: 1\n---\nB', 'pushed', 'x')).toBe('---\na: 1\npushed: x\n---\nB');
	});

	it('creates frontmatter when absent, and can blank a field', () => {
		expect(setField('Body', 'git', 'X/')).toBe('---\ngit: X/\n---\nBody');
		expect(setField('---\npushed: 1\n---\n', 'pushed', '')).toBe('---\npushed:\n---\n');
	});

	it('does not match a field name that is a prefix of another', () => {
		expect(getField('---\ngitx: 1\n---\n', 'git')).toBeNull();
	});
});

describe('repo paths', () => {
	it('joins the git folder and file name', () => {
		expect(repoFilePath('Classes/2026-B/RD - POGO 801/Assign/Final/', 'Final.md')).toBe(
			'Classes/2026-B/RD - POGO 801/Assign/Final/Final.md',
		);
		expect(repoFilePath('/A//B', 'n.md')).toBe('A/B/n.md');
		expect(repoFilePath('A/other.md', 'n.md')).toBe('A/other.md');
		expect(repoFilePath('', 'n.md')).toBe('n.md');
	});

	it('encodes the contents URL', () => {
		expect(contentsUrl('jsglazer/papers', 'A/RD - POGO 801/F.md', 'main')).toBe(
			'https://api.github.com/repos/jsglazer/papers/contents/A/RD%20-%20POGO%20801/F.md?ref=main',
		);
		expect(parseRepo('https://github.com/jsglazer/papers.git')).toEqual({
			owner: 'jsglazer',
			name: 'papers',
		});
		expect(parseRepo('nope')).toBeNull();
		expect(() => contentsUrl('bad', 'x')).toThrow();
	});

	it('stamps and names the original', () => {
		expect(pushedStamp(new Date(2026, 10, 5, 9, 7, 3))).toBe('20261105-090703');
		expect(sidecarPath('F/Final.md', '.original.md')).toBe('F/Final.original.md');
		expect(isSidecar('F/Final.original.md', '.original.md')).toBe(true);
		expect(isSidecar('F/Final.md', '.original.md')).toBe(false);
	});
});

const adds = (m: TrackMark[]): AddMark[] => m.filter((x): x is AddMark => x.type === 'add');
const dels = (m: TrackMark[]): DelMark[] => m.filter((x): x is DelMark => x.type === 'del');

/** Rebuild the original from current + marks: proves the marks describe the whole diff. */
function rebuildOriginal(current: string, marks: TrackMark[]): string {
	let out = '';
	let p = 0;
	const sorted = [...marks].sort((x, y) => {
		const px = x.type === 'add' ? x.from : x.at;
		const py = y.type === 'add' ? y.from : y.at;
		if (px !== py) return px - py;
		if (x.type === y.type) return 0;
		return x.type === 'del' ? -1 : 1;
	});
	for (const m of sorted) {
		if (m.type === 'copy-src') continue;
		if (m.type === 'del') {
			out += current.slice(p, m.at) + m.text;
			p = m.at;
		} else {
			out += current.slice(p, m.from);
			p = m.to;
		}
	}
	return out + current.slice(p);
}

describe('computeMarks', () => {
	const orig = `${FM}The cat sat on the mat.\nIt was a very sunny day.\n`;

	it('returns nothing when the bodies match, ignoring frontmatter', () => {
		expect(computeMarks(orig, orig)).toEqual([]);
		const stamped = setField(orig, 'pushed', '20261115-120000');
		expect(computeMarks(orig, stamped)).toEqual([]);
	});

	it('narrows a word replacement', () => {
		const cur = orig.replace('very sunny', 'quite sunny');
		const m = computeMarks(orig, cur);
		expect(dels(m).map((d) => d.text)).toEqual(['very']);
		expect(adds(m).map((a) => cur.slice(a.from, a.to))).toEqual(['quite']);
		expect(rebuildOriginal(cur, m)).toBe(orig);
	});

	it('marks a pure insertion and a pure deletion', () => {
		const cur = orig.replace('The cat', 'The black cat').replace(' on the mat', '');
		const m = computeMarks(orig, cur);
		expect(adds(m).map((a) => cur.slice(a.from, a.to).trim())).toContain('black');
		expect(dels(m).map((d) => d.text.trim())).toContain('on the mat');
		expect(rebuildOriginal(cur, m)).toBe(orig);
	});

	it('folds a multi-word rewrite into one replacement', () => {
		const cur = orig.replace('The cat sat', 'A dog lay');
		const m = computeMarks(orig, cur);
		expect(dels(m)).toHaveLength(1);
		expect(adds(m)).toHaveLength(1);
		expect(rebuildOriginal(cur, m)).toBe(orig);
	});

	it('detects a moved paragraph', () => {
		const a = `${FM}First paragraph is here and long.\n\nSecond paragraph text goes here.\n\nThird one ends it.\n`;
		const b = `${FM}Second paragraph text goes here.\n\nFirst paragraph is here and long.\n\nThird one ends it.\n`;
		const m = computeMarks(a, b);
		const moved = adds(m).filter((x) => x.moved);
		expect(moved).toHaveLength(1);
		expect(dels(m).filter((x) => x.moved)).toHaveLength(1);
		expect(moved[0].origin).toBeDefined();
		expect(rebuildOriginal(b, m)).toBe(a);
	});

	it('keeps a moved line next to an unrelated edit as a move', () => {
		const a = `${FM}States share much.\nNeighboring states share geography and resources.\nThis project asks why.\n`;
		const b = `${FM}States share much, at least on paper.\nThis project asks why.\nNeighboring states share geography and resources.\n`;
		const m = computeMarks(a, b);
		expect(adds(m).filter((x) => x.moved)).toHaveLength(1);
		const del = dels(m).find((x) => x.moved)!;
		// The moved-away line is shown where it was: after the first sentence's line.
		expect(del.at).toBe(b.indexOf('This project'));
		expect(rebuildOriginal(b, m)).toBe(a);
	});

	it('treats a short repeated phrase as a move only with a paste hint', () => {
		const a = `${FM}alpha beta gamma delta\n`;
		const b = `${FM}gamma alpha beta delta\n`;
		const plain = computeMarks(a, b);
		expect(adds(plain).some((x) => x.moved)).toBe(false);
		// The user cut "gamma " and pasted it at the start.
		const hinted = computeMarks(a, b, ['gamma ']);
		expect(adds(hinted).filter((x) => x.moved)).toHaveLength(1);
		expect(dels(hinted).filter((x) => x.moved)).toHaveLength(1);
		expect(rebuildOriginal(b, hinted)).toBe(a);
	});

	it('detects a pasted copy and marks its source', () => {
		const a = `${FM}Keep this sentence.\nEnd.\n`;
		const b = `${FM}Keep this sentence.\nEnd. Keep this sentence.\n`;
		const m = computeMarks(a, b, ['Keep this sentence.']);
		const src = m.find((x) => x.type === 'copy-src');
		expect(src).toBeDefined();
		expect(src!.at).toBe(b.indexOf('Keep'));
		expect(adds(m)[0].moved).toBe(true);
	});

	it('counts words and moves', () => {
		const cur = orig.replace('very sunny', 'bright and sunny');
		const s = markStats(cur, computeMarks(orig, cur));
		expect(s).toEqual({ addedWords: 2, deletedWords: 1, moves: 0 });
		expect(describeStats(s)).toBe('+2 words, −1 word');
	});
});

describe('criticExcerpts', () => {
	it('renders changes in CriticMarkup with line numbers', () => {
		const orig = `${FM}Line one.\nIt was a very sunny day.\n`;
		const cur = orig.replace('very', 'quite');
		const ex = criticExcerpts(cur, computeMarks(orig, cur));
		expect(ex).toHaveLength(1);
		expect(ex[0].text).toBe('It was a {--very--}{++quite++} sunny day.');
		expect(ex[0].line).toBe(cur.split('\n').indexOf('It was a quite sunny day.') + 1);
	});

	it('groups nearby changes and separates distant ones', () => {
		const filler = 'word '.repeat(60);
		const orig = `${FM}aaa bbb ccc\n${filler}\nxxx yyy zzz\n`;
		const cur = orig.replace('bbb', 'BBB').replace('yyy', 'YYY');
		expect(criticExcerpts(cur, computeMarks(orig, cur))).toHaveLength(2);
	});
});

describe('submitTagName', () => {
	it('prefixes submitted/ and keeps a plain name and stamp', () => {
		expect(submitTagName('Final', '20261118-162244')).toBe('submitted/Final/20261118-162244');
	});

	it('drops .md and turns spaces and git-illegal characters into -', () => {
		expect(submitTagName('Asgn 03: Theory~Hypo?.md', '2026-11-18 16:22')).toBe(
			'submitted/Asgn-03-Theory-Hypo/2026-11-18-16-22',
		);
	});

	it('never produces .., a leading dot, a .lock end or an empty segment', () => {
		const t = submitTagName('..hidden..name.lock', '***');
		expect(t).toBe('submitted/hidden.name/version');
		expect(t).not.toMatch(/\.\.|\/\.|\.lock(\/|$)|\/\//);
		expect(submitTagName('', '')).toBe('submitted/note/version');
	});

	it('passes git check-ref-format rules for a range of inputs', () => {
		// eslint-disable-next-line no-control-regex -- git forbids control characters in ref names
		const bad = /[\x00-\x20~^:?*[\\]|\.\.|@\{|\/\.|\.lock(\/|$)|\/$|\.$/;
		for (const [n, s] of [
			['Final', '20261118-162244'],
			['A [draft] ^v2', 'x@{y}'],
			['élève', '\t'],
		])
			expect(submitTagName(n, s)).not.toMatch(bad);
	});
});
