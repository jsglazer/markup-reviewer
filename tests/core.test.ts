import { describe, expect, it } from 'vitest';
import { locate, lineEndOffset } from '../src/core/anchor';
import { commonEnds, minimalChange, tidyDelete } from '../src/core/diff';
import { UndoStack, revertRange, type WriteRecord } from '../src/core/history';
import { anchorFromSelection, planChange } from '../src/core/apply';
import { parseReadResult } from '../src/core/schema';
import { numberLines } from '../src/core/prompt';

const edit = (
	o: Partial<{ original: string; before: string; after: string; line: number | null }>,
) => ({
	original: '',
	before: '',
	after: '',
	line: null,
	...o,
});

/** Apply a plan's change to doc, as the editor would. */
function apply(doc: string, text: string, e: ReturnType<typeof edit>): string {
	const p = planChange(doc, e, text);
	if (!p) throw new Error('not located');
	return doc.slice(0, p.change.from) + p.change.inserted + doc.slice(p.change.to);
}

describe('locate', () => {
	const doc = 'The cat sat.\nThe cat ran away.\nA dog barked.';

	it('finds an exact unique match', () => {
		const r = locate(doc, edit({ original: 'dog' }));
		expect(r).toMatchObject({ how: 'exact' });
		expect(doc.slice(r!.from, r!.to)).toBe('dog');
	});

	it('disambiguates repeats by context', () => {
		const r = locate(doc, edit({ original: 'cat', after: ' ran' }));
		expect(r!.from).toBe(doc.indexOf('cat ran'));
	});

	it('disambiguates repeats by line hint', () => {
		const r = locate(doc, edit({ original: 'The cat', line: 2 }));
		expect(r!.from).toBe(doc.indexOf('The cat ran'));
	});

	it('matches across differing whitespace', () => {
		const d = 'one  two\nthree';
		const r = locate(d, edit({ original: 'two three' }));
		expect(r).toMatchObject({ how: 'fuzzy', from: 5, to: d.length });
	});

	it('falls back to before/after brackets', () => {
		const r = locate(doc, edit({ original: 'zebra', before: 'A ', after: ' barked' }));
		expect(r).toMatchObject({ how: 'context' });
		expect(doc.slice(r!.from, r!.to)).toBe('dog');
	});

	it('places an insert between before and after', () => {
		const r = locate(doc, edit({ before: 'The cat ', after: 'ran' }));
		expect(r!.from).toBe(doc.indexOf('ran'));
		expect(r!.from).toBe(r!.to);
	});

	it('places an insert at the hinted line end as a last resort', () => {
		const r = locate(doc, edit({ line: 1 }));
		expect(r).toMatchObject({ how: 'line', from: 12, to: 12 });
	});

	it('returns null with nothing to go on', () => {
		expect(locate(doc, edit({ original: 'zebra' }))).toBeNull();
	});

	it('lineEndOffset clamps past the end', () => {
		expect(lineEndOffset('a\nb', 9)).toBe(3);
	});
});

describe('diff', () => {
	it('narrows to the changed word', () => {
		const doc = 'It was very good.';
		const c = minimalChange(doc, { from: 0, to: doc.length }, 'It was quite good.');
		expect(c).toMatchObject({ removed: 'very', inserted: 'quite' });
	});

	it('never splits a word', () => {
		const { prefix, suffix } = commonEnds('quiet', 'quite');
		expect(prefix).toBe(0);
		expect(suffix).toBe(0);
	});

	it('tidies the double space a word delete leaves', () => {
		const doc = 'a very big dog';
		const from = doc.indexOf('very');
		const c = tidyDelete(doc, { from, to: from + 4, removed: 'very', inserted: '' });
		expect(doc.slice(0, c.from) + doc.slice(c.to)).toBe('a big dog');
	});

	it('tidies a delete before punctuation', () => {
		const doc = 'the end indeed.';
		const from = doc.indexOf('indeed');
		const c = tidyDelete(doc, { from, to: from + 6, removed: 'indeed', inserted: '' });
		expect(doc.slice(0, c.from) + doc.slice(c.to)).toBe('the end.');
	});
});

describe('planChange end to end', () => {
	const doc = '# Title\n\nThis is **very** important text.\nSecond line here.';

	it('replaces inside markdown emphasis', () => {
		expect(apply(doc, 'quite', edit({ original: 'very' }))).toContain(
			'This is **quite** important',
		);
	});

	it('inserts at a caret', () => {
		expect(apply(doc, ' really', edit({ before: 'Second line', after: ' here' }))).toContain(
			'Second line really here',
		);
	});

	it('deletes cleanly', () => {
		expect(apply(doc, '', edit({ original: 'important' }))).toContain('**very** text.');
	});

	it('uses the edited text box contents', () => {
		expect(apply(doc, 'Third line', edit({ original: 'Second line' }))).toContain(
			'Third line here.',
		);
	});
});

describe('undo', () => {
	it('keeps at most the limit (min 5)', () => {
		const s = new UndoStack(5);
		for (let i = 0; i < 8; i++) s.push({ editId: String(i), prevStatus: 'pending', write: null });
		expect(s.size).toBe(5);
		expect(s.pop()!.editId).toBe('7');
		s.setLimit(2);
		expect(s.size).toBe(5 - 1); // setLimit floors at 5; 4 left after the pop
	});

	it('reverts at the recorded spot', () => {
		const before = 'It was very good.';
		const w: WriteRecord = { from: 7, removed: 'very', inserted: 'quite', ctx: 'It was ' };
		const after = 'It was quite good.';
		const r = revertRange(after, w)!;
		expect(after.slice(0, r.from) + w.removed + after.slice(r.to)).toBe(before);
	});

	it('finds the text again after unrelated edits shifted it', () => {
		const w: WriteRecord = { from: 7, removed: 'very', inserted: 'quite', ctx: 'It was ' };
		const shifted = 'Intro.\nIt was quite good.';
		const r = revertRange(shifted, w)!;
		expect(shifted.slice(r.from, r.to)).toBe('quite');
	});

	it('refuses when the written text is gone', () => {
		const w: WriteRecord = { from: 7, removed: 'very', inserted: 'quite', ctx: 'It was ' };
		expect(revertRange('It was rather good.', w)).toBeNull();
	});
});

describe('schema', () => {
	it('parses and normalises edits', () => {
		const r = parseReadResult(
			JSON.stringify({
				edits: [
					{
						page: 1,
						line: 3,
						kind: 'replace',
						original: 'a',
						replacement: '',
						before: '',
						after: '',
						mark: 'm',
						ink: 'red',
						confidence: 'high',
					},
					{ page: 0, line: 'x', kind: 'insert', original: 'b', replacement: 'c', ink: 'purple' },
					'junk',
				],
				notes: 'n',
			}),
		);
		expect(r.edits).toHaveLength(2);
		expect(r.edits[0].kind).toBe('delete');
		expect(r.edits[1]).toMatchObject({ kind: 'replace', page: 1, line: null, ink: 'other' });
		expect(r.notes).toBe('n');
	});

	it('tolerates prose around the JSON', () => {
		expect(parseReadResult('Here: {"edits":[],"notes":""} done').edits).toEqual([]);
	});
});

describe('helpers', () => {
	it('numbers lines with a padded prefix', () => {
		const n = numberLines(Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n'));
		expect(n.split('\n')[0]).toBe(' 1| l1');
		expect(n.split('\n')[9]).toBe('10| l10');
	});

	it('anchors on a selection', () => {
		const doc = 'first\nsecond line here';
		const from = doc.indexOf('line');
		const a = anchorFromSelection(doc, from, from + 4);
		expect(a).toEqual({ original: 'line', before: 'second ', after: ' here', line: 2 });
		expect(locate(doc, a)!.from).toBe(from);
	});
});
