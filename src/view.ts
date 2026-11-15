/**
 * The review side panel: one card per pen mark, Implement / Skip, an editable
 * text box per card, Undo, and the inline diff preview in the note.
 */
import {
	ItemView,
	MarkdownView,
	Notice,
	TFile,
	debounce,
	setIcon,
	type Editor,
	type WorkspaceLeaf,
} from 'obsidian';
import { anchorFromSelection, planChange } from './core/apply';
import { revertRange, type WriteRecord } from './core/history';
import type { ReviewEdit, ReviewSession } from './core/types';
import { addTrailMark, clearDiffMarks, removeTrailMark, showPreview } from './cm-diff';
import { confirm } from './modals';
import type MarkupReviewerPlugin from './main';

export const VIEW_TYPE = 'markup-reviewer-panel';

const KIND_LABEL: Record<ReviewEdit['kind'], string> = {
	replace: 'Replace',
	insert: 'Insert',
	delete: 'Delete',
	comment: 'Comment',
};

const HOW_LABEL: Record<string, string> = {
	fuzzy: 'Matched ignoring spacing',
	context: 'Placed by surrounding text',
	line: 'Placed at end of line',
};

/** A comment whose text box is empty: implementing it writes nothing. */
function isBareComment(edit: ReviewEdit): boolean {
	return edit.kind === 'comment' && edit.draft === '';
}

export class MarkupReviewView extends ItemView {
	private busy: { message: string; abort: AbortController } | null = null;
	private error: string | null = null;
	private selectedId: string | null = null;
	private readonly refreshSoon = debounce(() => this.refresh(), 300, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: MarkupReviewerPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Markup review';
	}
	getIcon(): string {
		return 'pen-line';
	}

	private get session(): ReviewSession | null {
		return this.plugin.activeSession();
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('markup-reviewer');
		this.registerEvent(
			this.app.workspace.on('editor-change', (_editor, info) => {
				if (this.session && info.file?.path === this.session.notePath) this.refreshSoon();
			}),
		);
		this.render();
		await Promise.resolve();
	}

	async onClose(): Promise<void> {
		const ed = this.findEditor();
		if (ed) showPreview(ed, null, false);
		await Promise.resolve();
	}

	// ── State changes driven by the plugin ──────────────────────────────

	setBusy(message: string, abort: AbortController): void {
		this.busy = { message, abort };
		this.error = null;
		this.render();
	}

	setError(message: string): void {
		this.busy = null;
		this.error = message;
		this.render();
	}

	/** Show a session (fresh from Claude or resumed) and select its first pending edit. */
	showSession(): void {
		this.busy = null;
		this.error = null;
		const s = this.session;
		this.selectedId = s?.edits.find((e) => e.status === 'pending')?.id ?? null;
		this.render();
		void this.select(this.selectedId, true);
	}

	/** Re-render and re-preview after the note or settings changed. */
	refresh(): void {
		this.render();
		this.updatePreview(false);
	}

	// ── Editor access ───────────────────────────────────────────────────

	private findMarkdownView(): MarkdownView | null {
		const path = this.session?.notePath;
		if (!path) return null;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file?.path === path) return v;
		}
		return null;
	}

	private findEditor(): Editor | null {
		return this.findMarkdownView()?.editor ?? null;
	}

	/** The note's editor, opening the note if it isn't open. */
	private async ensureEditor(): Promise<Editor | null> {
		const open = this.findMarkdownView();
		if (open) return open.editor;
		const s = this.session;
		const file = s ? this.app.vault.getAbstractFileByPath(s.notePath) : null;
		if (!(file instanceof TFile)) {
			new Notice(`Markup Reviewer: the note ${s?.notePath ?? ''} no longer exists.`);
			return null;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		return leaf.view instanceof MarkdownView ? leaf.view.editor : null;
	}

	// ── Selection and preview ───────────────────────────────────────────

	private edit(id: string | null): ReviewEdit | undefined {
		return id ? this.session?.edits.find((e) => e.id === id) : undefined;
	}

	private async select(id: string | null, scroll: boolean): Promise<void> {
		this.selectedId = id;
		this.contentEl.querySelectorAll('.markup-reviewer-card').forEach((el) => {
			el.toggleClass('is-selected', (el as HTMLElement).dataset.id === id);
		});
		if (scroll && id) {
			this.contentEl
				.querySelector(`.markup-reviewer-card[data-id="${id}"]`)
				?.scrollIntoView({ block: 'nearest' });
			await this.ensureEditor();
		}
		this.updatePreview(scroll);
	}

	private updatePreview(scroll: boolean): void {
		const editor = this.findEditor();
		if (!editor) return;
		const edit = this.edit(this.selectedId);
		if (!edit || edit.status !== 'pending') {
			showPreview(editor, null, false);
			return;
		}
		const plan = planChange(editor.getValue(), edit, edit.draft);
		if (!plan) {
			showPreview(editor, null, false);
			return;
		}
		if (isBareComment(edit)) {
			const { from, to } = plan.located;
			showPreview(editor, { from, to, inserted: '', mode: 'focus' }, scroll);
			return;
		}
		const { change } = plan;
		showPreview(editor, { from: change.from, to: change.to, inserted: change.inserted }, scroll);
	}

	// ── Actions ─────────────────────────────────────────────────────────

	private async implement(edit: ReviewEdit): Promise<void> {
		if (edit.status !== 'pending') return;
		if (isBareComment(edit)) {
			// "Resolve": the remark needed no text change (or was handled by hand).
			this.plugin.undo.push({ editId: edit.id, prevStatus: edit.status, write: null });
			edit.status = 'implemented';
			this.afterAction(edit);
			return;
		}
		const editor = await this.ensureEditor();
		if (!editor) return;
		const doc = editor.getValue();
		const plan = planChange(doc, edit, edit.draft);
		if (!plan) {
			new Notice(
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Use selection" is the literal button label
				"Couldn't find this edit's text in the note. Select the text (or put the cursor where it goes) in the note, then click Use selection.",
			);
			return;
		}
		const { change } = plan;
		let write: WriteRecord | null = null;
		if (change.removed !== '' || change.inserted !== '') {
			editor.replaceRange(
				change.inserted,
				editor.offsetToPos(change.from),
				editor.offsetToPos(change.to),
			);
			write = {
				from: change.from,
				removed: change.removed,
				inserted: change.inserted,
				ctx: doc.slice(Math.max(0, change.from - 30), change.from),
			};
			// A tracked note already shows every change in its markup layer.
			if (
				this.plugin.settings.keepTrail &&
				!this.plugin.tracker.isTracked(this.session?.notePath)
			) {
				addTrailMark(editor, {
					editId: edit.id,
					from: change.from,
					inserted: change.inserted,
					removed: change.removed,
				});
			}
		}
		this.plugin.undo.push({ editId: edit.id, prevStatus: edit.status, write });
		edit.status = 'implemented';
		this.afterAction(edit);
	}

	private skip(edit: ReviewEdit): void {
		if (edit.status !== 'pending') return;
		this.plugin.undo.push({ editId: edit.id, prevStatus: edit.status, write: null });
		edit.status = 'skipped';
		this.afterAction(edit);
	}

	private restore(edit: ReviewEdit): void {
		edit.status = 'pending';
		this.plugin.saveSessionSoon();
		this.render();
		void this.select(edit.id, true);
	}

	private afterAction(edit: ReviewEdit): void {
		this.plugin.saveSessionSoon();
		let next: string | null = edit.id;
		if (this.plugin.settings.autoAdvance) next = this.nextPending(edit.id) ?? edit.id;
		this.render();
		void this.select(next, true);
	}

	private nextPending(afterId: string): string | null {
		const edits = this.session?.edits ?? [];
		const start = edits.findIndex((e) => e.id === afterId);
		for (let k = 1; k <= edits.length; k++) {
			const e = edits[(start + k) % edits.length];
			if (e.status === 'pending') return e.id;
		}
		return null;
	}

	async undoLast(): Promise<void> {
		const entry = this.plugin.undo.peek();
		if (!entry) {
			new Notice('Nothing to undo.');
			return;
		}
		if (entry.write) {
			const editor = await this.ensureEditor();
			if (!editor) return;
			const range = revertRange(editor.getValue(), entry.write);
			if (!range) {
				new Notice(
					"Can't undo: the text this edit wrote has since been changed in the note. Use the editor's own undo instead.",
				);
				return;
			}
			editor.replaceRange(
				entry.write.removed,
				editor.offsetToPos(range.from),
				editor.offsetToPos(range.to),
			);
			removeTrailMark(editor, entry.editId);
		}
		this.plugin.undo.pop();
		const edit = this.edit(entry.editId);
		if (edit) edit.status = entry.prevStatus;
		this.plugin.saveSessionSoon();
		this.render();
		void this.select(entry.editId, true);
	}

	private useSelection(edit: ReviewEdit): void {
		const mv = this.findMarkdownView();
		if (!mv) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Use selection" is the literal button label
			new Notice('Open the note, select the text this edit applies to, then click Use selection.');
			return;
		}
		const ed = mv.editor;
		const a = ed.posToOffset(ed.getCursor('from'));
		const b = ed.posToOffset(ed.getCursor('to'));
		Object.assign(edit, anchorFromSelection(ed.getValue(), a, b));
		edit.reanchored = true;
		if (edit.kind !== 'comment') {
			edit.kind = !edit.original ? 'insert' : edit.draft ? 'replace' : 'delete';
		}
		this.plugin.saveSessionSoon();
		this.render();
		void this.select(edit.id, false);
	}

	clearMarks(): void {
		const ed = this.findEditor();
		if (ed) clearDiffMarks(ed);
		this.updatePreview(false);
	}

	private async endReview(): Promise<void> {
		const s = this.session;
		if (!s) return;
		const pending = s.edits.filter((e) => e.status === 'pending').length;
		if (pending > 0) {
			const ok = await confirm(
				this.app,
				'End markup review?',
				`${pending} edit${pending === 1 ? ' is' : 's are'} still pending. Ending the review discards them and clears the highlights. Changes already made to the note stay.`,
				'End review',
			);
			if (!ok) return;
		}
		const ed = this.findEditor();
		if (ed) clearDiffMarks(ed);
		await this.plugin.endSession();
		this.selectedId = null;
		this.render();
	}

	// ── Rendering ───────────────────────────────────────────────────────

	render(): void {
		const root = this.contentEl;
		root.empty();
		const s = this.session;

		if (this.busy) {
			const box = root.createDiv('markup-reviewer-busy');
			box.createDiv('markup-reviewer-spinner');
			box.createDiv({ text: this.busy.message });
			const abort = this.busy.abort;
			box.createEl('button', { text: 'Cancel' }).onclick = () => abort.abort();
			return;
		}

		if (this.error) {
			const err = root.createDiv('markup-reviewer-error');
			err.createEl('strong', { text: 'Could not read the scan. ' });
			err.appendText(this.error);
		}

		if (!s) {
			const empty = root.createDiv('markup-reviewer-empty');
			empty.createEl('p', {
				text: 'Open the note you printed, then pick the scan of your marked-up printout.',
			});
			const btn = empty.createEl('button', { text: 'Review markup…', cls: 'mod-cta' });
			btn.onclick = () => void this.plugin.startFromActiveNote();
			return;
		}

		this.renderHeader(root, s);

		if (s.notes) {
			const det = root.createEl('details', { cls: 'markup-reviewer-notes' });
			det.createEl('summary', { text: 'Notes from the scan' });
			det.createEl('p', { text: s.notes });
		}

		if (s.edits.length === 0) {
			root.createEl('p', {
				cls: 'markup-reviewer-empty',
				text: 'Claude found no pen marks to turn into edits.',
			});
			return;
		}

		const doc = this.findEditor()?.getValue() ?? null;
		const list = root.createDiv('markup-reviewer-list');
		for (const edit of s.edits) this.renderCard(list, edit, doc);
	}

	private renderHeader(root: HTMLElement, s: ReviewSession): void {
		const head = root.createDiv('markup-reviewer-head');
		const note = head.createDiv('markup-reviewer-note');
		const link = note.createEl('a', { text: s.notePath.replace(/\.md$/, '').split('/').pop() });
		link.onclick = () => void this.ensureEditor();
		head.createDiv({ cls: 'markup-reviewer-sub', text: `Scan: ${s.pdfName}` });

		const done = s.edits.filter((e) => e.status === 'implemented').length;
		const skipped = s.edits.filter((e) => e.status === 'skipped').length;
		const pending = s.edits.length - done - skipped;
		head.createDiv({
			cls: 'markup-reviewer-sub',
			text: `${pending} pending · ${done} implemented · ${skipped} skipped`,
		});

		const bar = head.createDiv('markup-reviewer-toolbar');
		const undoBtn = bar.createEl('button', {
			text: `Undo (${this.plugin.undo.size})`,
			attr: { 'aria-label': 'Undo the last implement or skip action' },
		});
		undoBtn.disabled = this.plugin.undo.size === 0;
		undoBtn.onclick = () => void this.undoLast();

		const nextBtn = bar.createEl('button', { text: 'Next pending' });
		nextBtn.disabled = pending === 0;
		nextBtn.onclick = () => {
			const n = this.nextPending(this.selectedId ?? s.edits[s.edits.length - 1].id);
			if (n) void this.select(n, true);
		};

		bar.createEl('button', {
			text: 'Clear marks',
			attr: { 'aria-label': 'Remove the green/red highlights from the note' },
		}).onclick = () => this.clearMarks();

		bar.createEl('button', { text: 'End review' }).onclick = () => void this.endReview();
	}

	private renderCard(list: HTMLElement, edit: ReviewEdit, doc: string | null): void {
		const card = list.createDiv('markup-reviewer-card');
		card.dataset.id = edit.id;
		card.addClass(`is-${edit.status}`);
		if (edit.id === this.selectedId) card.addClass('is-selected');
		card.addEventListener('click', (ev) => {
			const t = ev.target as HTMLElement;
			if (t.closest('button, textarea')) return;
			void this.select(edit.id, true);
		});

		const top = card.createDiv('markup-reviewer-card-top');
		top.createSpan({
			cls: `markup-reviewer-ink markup-reviewer-ink-${edit.ink}`,
			attr: { 'aria-label': `${edit.ink} ink` },
		});
		top.createSpan({
			cls: 'markup-reviewer-where',
			text: `p${edit.page}${edit.line !== null ? ` · L${edit.line}` : ''}`,
		});
		top.createSpan({ cls: 'markup-reviewer-kind', text: KIND_LABEL[edit.kind] });
		if (edit.confidence !== 'high')
			top.createSpan({
				cls: `markup-reviewer-conf is-${edit.confidence}`,
				text: `${edit.confidence} confidence`,
			});
		if (edit.status !== 'pending')
			top.createSpan({ cls: 'markup-reviewer-status', text: edit.status });

		if (edit.mark) card.createDiv({ cls: 'markup-reviewer-mark', text: edit.mark });

		if (edit.original) {
			card.createDiv({ cls: 'markup-reviewer-original', text: edit.original });
		}

		if (edit.status !== 'pending') {
			const row = card.createDiv('markup-reviewer-actions');
			if (edit.draft) card.createDiv({ cls: 'markup-reviewer-final', text: edit.draft });
			if (edit.status === 'skipped')
				row.createEl('button', { text: 'Restore' }).onclick = () => this.restore(edit);
			return;
		}

		const box = card.createEl('textarea', {
			cls: 'markup-reviewer-text',
			attr: {
				rows: String(Math.min(8, Math.max(2, Math.ceil(edit.draft.length / 40)))),
				placeholder:
					edit.kind === 'delete'
						? 'Deletes the text above. Type here to replace it instead.'
						: edit.kind === 'comment'
							? 'Type the text to put in place of the passage above, or Skip.'
							: 'Text to insert',
			},
		});
		box.value = edit.draft;
		box.addEventListener('focus', () => {
			if (this.selectedId !== edit.id) void this.select(edit.id, true);
		});
		box.addEventListener('input', () => {
			edit.draft = box.value;
			card.toggleClass('is-edited', edit.draft !== edit.replacement);
			this.updatePreview(false);
			this.plugin.saveSessionSoon();
		});
		box.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
				ev.preventDefault();
				void this.implement(edit);
			}
		});
		if (edit.draft !== edit.replacement) card.addClass('is-edited');

		if (doc !== null) {
			const plan = planChange(doc, edit, edit.draft);
			if (!plan) {
				card.createDiv({
					cls: 'markup-reviewer-warn',
					text: 'Not found in the note. Select the text (or place the cursor) in the note and click Use selection.',
				});
			} else if (plan.located.how !== 'exact') {
				card.createDiv({ cls: 'markup-reviewer-hint', text: HOW_LABEL[plan.located.how] });
			}
		}

		const row = card.createDiv('markup-reviewer-actions');
		const impl = row.createEl('button', { cls: 'mod-cta' });
		impl.setText(isBareComment(edit) ? 'Resolve' : 'Implement');
		impl.setAttr('aria-label', 'Apply to the note (Ctrl/Cmd+Enter in the text box)');
		impl.onclick = () => void this.implement(edit);
		row.createEl('button', { text: 'Skip' }).onclick = () => this.skip(edit);
		const sel = row.createEl('button', {
			cls: 'markup-reviewer-sel',
			attr: { 'aria-label': 'Re-anchor this edit on the text selected in the note' },
		});
		setIcon(sel, 'text-cursor-input');
		sel.appendText(' Use selection');
		sel.onclick = () => this.useSelection(edit);
	}
}
