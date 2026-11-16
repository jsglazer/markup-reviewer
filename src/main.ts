import {
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	arrayBufferToBase64,
	debounce,
	type WorkspaceLeaf,
} from 'obsidian';
import { MAX_PDF_BYTES, readMarkup } from './claude';
import { markupDiffExtension } from './cm-diff';
import { UndoStack } from './core/history';
import type { ReviewSession } from './core/types';
import { askResume, pickPdf } from './modals';
import {
	DEFAULT_SETTINGS,
	MarkupReviewerSettingTab,
	type MarkupReviewerSettings,
} from './settings';
import { EditTracker } from './tracker';
import { MarkupReviewView, VIEW_TYPE } from './view';

export default class MarkupReviewerPlugin extends Plugin {
	settings!: MarkupReviewerSettings;
	/** Undo for panel actions; lives on the plugin so closing the panel keeps it. */
	undo!: UndoStack;
	/** Manual edit tracking against the GitHub original. */
	tracker!: EditTracker;
	/** Path of the note whose review the panel shows. */
	private activePath: string | null = null;

	readonly saveSessionSoon = debounce(() => void this.saveSettings(), 500, true);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.undo = new UndoStack(this.settings.undoLevels);

		this.registerView(VIEW_TYPE, (leaf) => new MarkupReviewView(leaf, this));
		this.registerEditorExtension(markupDiffExtension);
		this.addSettingTab(new MarkupReviewerSettingTab(this.app, this));
		this.tracker = new EditTracker(this);
		this.tracker.load();
		this.registerTrackCommands();

		this.addRibbonIcon('pen-line', 'Review markup from a scanned PDF', () => {
			void this.startFromActiveNote();
		});

		this.addCommand({
			id: 'review-scan',
			name: 'Review markup from a scanned PDF',
			callback: () => void this.startFromActiveNote(),
		});

		this.addCommand({
			id: 'open-panel',
			name: 'Toggle review panel',
			callback: () => void this.togglePanel(),
		});

		this.addCommand({
			id: 'undo',
			name: 'Undo last implement or skip',
			callback: () => void this.view()?.undoLast(),
		});

		this.addCommand({
			id: 'clear-marks',
			name: 'Clear diff highlights',
			callback: () => this.view()?.clearMarks(),
		});

		// Keep saved sessions attached to their note through renames and deletes.
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				const s = this.settings.sessions[oldPath];
				if (!s) return;
				delete this.settings.sessions[oldPath];
				s.notePath = file.path;
				this.settings.sessions[file.path] = s;
				if (this.activePath === oldPath) this.activePath = file.path;
				void this.saveSettings();
				this.view()?.refresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (!this.settings.sessions[file.path]) return;
				delete this.settings.sessions[file.path];
				if (this.activePath === file.path) {
					this.activePath = null;
					this.undo.clear();
				}
				void this.saveSettings();
				this.view()?.refresh();
			}),
		);
	}

	onunload(): void {
		this.tracker?.unload();
		this.saveSessionSoon.run();
	}

	/** Commands and ribbon button for manual edit tracking. */
	private registerTrackCommands(): void {
		const withNote = (fn: (file: TFile) => Promise<void>) => (): void => {
			const file = this.activeNote();
			if (!file) {
				new Notice('Open the note first, then run this command again.');
				return;
			}
			void fn(file);
		};

		// Stop, Pause and Discard act on the tracked note, whichever note is active.
		const withLocked = (fn: (file: TFile) => Promise<void>) => (): void => {
			const locked = this.tracker.lockedFile();
			if (locked) void fn(locked);
			else withNote(fn)();
		};

		this.addRibbonIcon('git-compare', 'Track edits, or stop and push them', () => {
			const locked = this.tracker.lockedFile();
			if (locked) {
				void this.tracker.stop(locked);
				return;
			}
			const file = this.activeNote();
			if (!file) {
				new Notice('Open the note first.');
				return;
			}
			void this.tracker.start(file);
		});

		this.addCommand({
			id: 'track-start',
			name: 'Start tracking edits in this note',
			callback: withNote((f) => this.tracker.start(f)),
		});
		// Ids kept from earlier versions so existing hotkeys still work:
		// track-done is now Stop (push), track-stop is now Discard.
		this.addCommand({
			id: 'track-done',
			name: 'Stop: commit and push to GitHub',
			callback: withLocked((f) => this.tracker.stop(f)),
		});
		this.addCommand({
			id: 'track-pause',
			name: 'Pause or resume tracking',
			callback: withLocked((f) => this.tracker.togglePause(f)),
		});
		this.addCommand({
			id: 'track-stop',
			name: 'Discard tracking without pushing',
			callback: withLocked((f) => this.tracker.discard(f)),
		});
		this.addCommand({
			id: 'track-cycle',
			name: 'Cycle display: original, markup, final',
			callback: () => void this.tracker.cycleMode(),
		});
		this.addCommand({
			id: 'track-show-original',
			name: 'Show the original',
			callback: () => void this.tracker.setMode('original'),
		});
		this.addCommand({
			id: 'track-show-markup',
			name: 'Show the markup',
			callback: () => void this.tracker.setMode('markup'),
		});
		this.addCommand({
			id: 'track-show-final',
			name: 'Show the final text',
			callback: () => void this.tracker.setMode('final'),
		});
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<MarkupReviewerSettings>;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			sessions: data.sessions ?? {},
			tracking: data.tracking ?? {},
		};
		this.settings.undoLevels = Math.max(5, this.settings.undoLevels);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onUndoLevelsChanged(): void {
		this.undo.setLimit(this.settings.undoLevels);
		this.view()?.refresh();
	}

	refreshView(): void {
		this.view()?.refresh();
	}

	/** Redraw the panel's tracking buttons (active note or tracking state changed). */
	refreshTrackBar(): void {
		this.view()?.renderTrackBar();
	}

	activeSession(): ReviewSession | null {
		return this.activePath ? (this.settings.sessions[this.activePath] ?? null) : null;
	}

	async endSession(): Promise<void> {
		if (this.activePath) delete this.settings.sessions[this.activePath];
		this.activePath = null;
		this.undo.clear();
		await this.saveSettings();
	}

	private view(): MarkupReviewView | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		return leaf?.view instanceof MarkupReviewView ? leaf.view : null;
	}

	/** The sidebar a leaf sits in, if any. */
	private sidebarOf(leaf: WorkspaceLeaf) {
		const ws = this.app.workspace;
		const root = leaf.getRoot();
		if (root === ws.rightSplit) return ws.rightSplit;
		if (root === ws.leftSplit) return ws.leftSplit;
		return null;
	}

	/**
	 * Close the review panel and collapse its sidebar if it's showing; otherwise
	 * open (or reveal) it and expand the sidebar.
	 */
	private async togglePanel(): Promise<void> {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (leaf && leaf.view.containerEl.isShown()) {
			const side = this.sidebarOf(leaf);
			leaf.detach();
			side?.collapse();
			return;
		}
		const view = await this.openPanel();
		if (view) this.sidebarOf(view.leaf)?.expand();
	}

	private async openPanel(): Promise<MarkupReviewView | null> {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return null;
			await right.setViewState({ type: VIEW_TYPE, active: true });
			leaf = right;
		}
		await this.app.workspace.revealLeaf(leaf);
		// Show the active note's saved review if there is one and nothing else is showing.
		if (!this.activePath) {
			const file = this.app.workspace.getActiveFile();
			if (file && this.settings.sessions[file.path]) this.switchTo(file.path);
		}
		const view = leaf.view instanceof MarkupReviewView ? leaf.view : null;
		view?.showSession();
		return view;
	}

	/** Make `path` the panel's review, resetting undo when the note changes. */
	private switchTo(path: string): void {
		if (this.activePath !== path) this.undo.clear();
		this.activePath = path;
	}

	private activeNote(): TFile | null {
		const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = mv?.file ?? this.app.workspace.getActiveFile();
		return file && file.extension === 'md' ? file : null;
	}

	apiKey(): string | null {
		const id = this.settings.apiKeySecret;
		if (!id) return null;
		return this.app.secretStorage.getSecret(id);
	}

	/** Command entry point: the active note is the target; pick (or resume) a scan. */
	async startFromActiveNote(): Promise<void> {
		const file = this.activeNote();
		if (!file) {
			new Notice('Open the note you printed first, then run this command again.');
			return;
		}

		const saved = this.settings.sessions[file.path];
		if (saved) {
			const pending = saved.edits.filter((e) => e.status === 'pending').length;
			const choice = await askResume(this.app, pending, saved.pdfName);
			if (choice === null) return;
			if (choice === 'resume') {
				this.switchTo(file.path);
				await this.openPanel();
				return;
			}
		}

		const pdf = await pickPdf(this.app, this.settings.scanFolder);
		if (!pdf) return;
		if (pdf.bytes.byteLength > MAX_PDF_BYTES) {
			new Notice(
				`Markup Reviewer: ${pdf.name} is ${(pdf.bytes.byteLength / 1048576).toFixed(1)} MB; the limit is 23 MB. Rescan at a lower resolution or split the PDF.`,
			);
			return;
		}

		const key = this.apiKey();
		if (!key) {
			new Notice('No API key found. Set the Anthropic API key secret in the plugin settings.');
			return;
		}

		await this.readScan(file, pdf.name, pdf.bytes, key);
	}

	private async readScan(
		file: TFile,
		pdfName: string,
		bytes: ArrayBuffer,
		key: string,
	): Promise<void> {
		// Show the panel in its busy state without switching away from any review it showed.
		const view = await this.openPanel();
		const abort = new AbortController();
		const mb = (bytes.byteLength / 1048576).toFixed(1);
		view?.setBusy(
			`Reading the pen markup in ${pdfName} (${mb} MB)… This can take a minute or two.`,
			abort,
		);

		// Prefer the open editor's text (it may hold unsaved keystrokes).
		const open = this.app.workspace
			.getLeavesOfType('markdown')
			.map((l) => l.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
		const markdown = open ? open.editor.getValue() : await this.app.vault.read(file);

		try {
			const result = await readMarkup({
				apiKey: key,
				model: this.settings.model,
				effort: this.settings.effort,
				pdfBase64: arrayBufferToBase64(bytes),
				noteName: file.basename,
				markdown,
				signal: abort.signal,
			});
			const stamp = Date.now().toString(36);
			const session: ReviewSession = {
				notePath: file.path,
				pdfName,
				createdAt: new Date().toISOString(),
				model: this.settings.model,
				usage: result.usage,
				notes: result.notes,
				edits: result.edits.map((e, i) => ({
					...e,
					id: `${stamp}-${i}`,
					status: 'pending',
					draft: e.replacement,
					reanchored: false,
				})),
			};
			this.settings.sessions[file.path] = session;
			this.switchTo(file.path);
			this.undo.clear();
			await this.saveSettings();
			new Notice(
				`Markup Reviewer: ${session.edits.length} edit${session.edits.length === 1 ? '' : 's'} found (${result.usage} tokens).`,
			);
			(this.view() ?? view)?.showSession();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			(this.view() ?? view)?.setError(msg);
			if (msg !== 'Cancelled.') new Notice(`Markup Reviewer: ${msg}`);
		}
	}
}
