/**
 * GitHub-style inline diff decorations in the note editor.
 *
 *   preview — the selected pending edit: the text it removes is struck on a light-red
 *             background, the text it adds is shown beside it on light green.
 *   trail   — implemented edits: the added text stays light green and the removed text
 *             is shown struck in light red, until cleared. Both map through later edits.
 *
 * Decorations are display-only; nothing here writes to the note. This is the
 * only module that touches Obsidian's undocumented `editor.cm` (the CodeMirror
 * 6 EditorView behind a MarkdownView). Targeted against Obsidian 1.14.4
 * (@codemirror/view 6.43.13).
 */
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { Editor } from 'obsidian';

export interface DiffSpec {
	from: number;
	to: number;
	inserted: string;
	/** 'focus' just points at a passage (a comment with no replacement text) instead of diffing it. */
	mode?: 'diff' | 'focus';
}

export interface TrailSpec {
	editId: string;
	/** Start of the inserted text. */
	from: number;
	inserted: string;
	removed: string;
}

class TextWidget extends WidgetType {
	constructor(
		readonly text: string,
		readonly cls: string,
		readonly title: string,
	) {
		super();
	}
	eq(other: TextWidget): boolean {
		return other.text === this.text && other.cls === this.cls;
	}
	toDOM(): HTMLElement {
		const el = activeDocument.createElement('span');
		el.className = this.cls;
		el.textContent = this.text;
		el.setAttribute('aria-label', this.title);
		return el;
	}
	ignoreEvent(): boolean {
		return false;
	}
}

const setPreview = StateEffect.define<DiffSpec | null>();
const addTrail = StateEffect.define<TrailSpec>();
const removeTrail = StateEffect.define<string>();
const clearTrail = StateEffect.define<null>();

function clamp(n: number, len: number): number {
	return Math.min(Math.max(n, 0), len);
}

function previewDecorations(spec: DiffSpec, docLen: number): DecorationSet {
	const from = clamp(spec.from, docLen);
	const to = clamp(Math.max(spec.to, from), docLen);
	const ranges: Range<Decoration>[] = [];
	if (spec.mode === 'focus' && to > from) {
		ranges.push(Decoration.mark({ class: 'markup-reviewer-focus' }).range(from, to));
		return Decoration.set(ranges, true);
	}
	if (to > from) ranges.push(Decoration.mark({ class: 'markup-reviewer-del' }).range(from, to));
	if (spec.inserted) {
		ranges.push(
			Decoration.widget({
				widget: new TextWidget(spec.inserted, 'markup-reviewer-add', 'Proposed insertion'),
				side: 1,
			}).range(to),
		);
	} else if (to === from) {
		// Nothing to show but a position (a comment with no text yet): a caret marker.
		ranges.push(
			Decoration.widget({
				widget: new TextWidget('‸', 'markup-reviewer-caret', 'Edit location'),
				side: 1,
			}).range(to),
		);
	}
	return Decoration.set(ranges, true);
}

function trailDecorations(spec: TrailSpec, docLen: number): Range<Decoration>[] {
	const from = clamp(spec.from, docLen);
	const to = clamp(spec.from + spec.inserted.length, docLen);
	const out: Range<Decoration>[] = [];
	if (spec.removed) {
		out.push(
			Decoration.widget({
				widget: new TextWidget(spec.removed, 'markup-reviewer-trail-del', 'Removed text'),
				side: -1,
				editId: spec.editId,
			}).range(from),
		);
	}
	if (to > from) {
		out.push(
			Decoration.mark({ class: 'markup-reviewer-trail-add', editId: spec.editId }).range(from, to),
		);
	}
	return out;
}

const previewField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		let next = deco.map(tr.changes);
		for (const e of tr.effects) {
			if (e.is(setPreview))
				next = e.value ? previewDecorations(e.value, tr.state.doc.length) : Decoration.none;
		}
		return next;
	},
	provide: (f) => EditorView.decorations.from(f),
});

const trailField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		let next = deco.map(tr.changes);
		for (const e of tr.effects) {
			if (e.is(addTrail)) {
				next = next.update({ add: trailDecorations(e.value, tr.state.doc.length), sort: true });
			} else if (e.is(removeTrail)) {
				const id = e.value;
				next = next.update({
					filter: (_f, _t, d) => (d.spec as { editId?: string }).editId !== id,
				});
			} else if (e.is(clearTrail)) {
				next = Decoration.none;
			}
		}
		return next;
	},
	provide: (f) => EditorView.decorations.from(f),
});

/** Register once via plugin.registerEditorExtension. */
export const markupDiffExtension: Extension = [previewField, trailField];

function viewOf(editor: Editor): EditorView | null {
	const cm = (editor as unknown as { cm?: unknown }).cm;
	return cm instanceof EditorView ? cm : null;
}

/** Show the diff for one pending edit (null clears it), optionally scrolling to it. */
export function showPreview(editor: Editor, spec: DiffSpec | null, scroll: boolean): void {
	const view = viewOf(editor);
	if (!view) return;
	const effects: StateEffect<unknown>[] = [setPreview.of(spec)];
	if (spec && scroll) {
		effects.push(
			EditorView.scrollIntoView(clamp(spec.from, view.state.doc.length), { y: 'center' }),
		);
	}
	view.dispatch({ effects });
}

export function addTrailMark(editor: Editor, spec: TrailSpec): void {
	viewOf(editor)?.dispatch({ effects: addTrail.of(spec) });
}

export function removeTrailMark(editor: Editor, editId: string): void {
	viewOf(editor)?.dispatch({ effects: removeTrail.of(editId) });
}

export function clearDiffMarks(editor: Editor): void {
	viewOf(editor)?.dispatch({ effects: [clearTrail.of(null), setPreview.of(null)] });
}

/** Scroll the editor so `pos` is centred. */
export function scrollToOffset(editor: Editor, pos: number): void {
	const view = viewOf(editor);
	if (!view) return;
	view.dispatch({
		effects: EditorView.scrollIntoView(clamp(pos, view.state.doc.length), { y: 'center' }),
	});
}
