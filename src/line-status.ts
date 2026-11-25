import { EditorView } from '@codemirror/view';
import { MarkdownView } from 'obsidian';
import type MarkupReviewerPlugin from './main';
import { formatCursor } from './core/cursor';

/**
 * Status-bar readout of the cursor's line (and optionally column) in the active
 * editor. Obsidian's editor-change event fires only on edits, so a CodeMirror
 * update listener catches plain cursor moves too.
 */
export class LineStatus {
	private el: HTMLElement | null = null;
	private frame: number | null = null;

	constructor(private readonly plugin: MarkupReviewerPlugin) {}

	load(): void {
		const p = this.plugin;
		this.el = p.addStatusBarItem();
		this.el.addClass('markup-reviewer-line');

		p.registerEditorExtension(
			EditorView.updateListener.of((u) => {
				if (u.selectionSet || u.docChanged || u.focusChanged) this.schedule();
			}),
		);
		p.registerEvent(p.app.workspace.on('active-leaf-change', () => this.schedule()));
		p.registerEvent(p.app.workspace.on('layout-change', () => this.schedule()));
		p.registerEvent(p.app.workspace.on('file-open', () => this.schedule()));
		p.register(() => {
			if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		});
		p.app.workspace.onLayoutReady(() => this.refresh());
	}

	/** Coalesce bursts of cursor moves into one repaint per frame. */
	schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.refresh();
		});
	}

	refresh(): void {
		const el = this.el;
		if (!el) return;
		const display = this.plugin.settings.cursorDisplay;
		const mv = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (display === 'off' || !mv || mv.getMode() !== 'source') {
			el.hide();
			return;
		}
		const pos = mv.editor.getCursor('head');
		el.setText(formatCursor(pos.line, pos.ch, display));
		el.show();
	}
}
