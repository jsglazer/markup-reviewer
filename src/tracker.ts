/**
 * Manual edit tracking: the note always holds your current text, the original
 * is the copy on GitHub (cached in a visible file next to the note), and the
 * red/green/purple marks are recomputed by comparing the two shortly after
 * every change. "Stop" checks GitHub, has Claude draft a commit message for
 * you to edit or approve, stamps `pushed:`, and pushes the note.
 */
import { MarkdownView, Notice, TFile, setIcon, type Editor } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { draftCommitMessage } from './claude';
import { setPasteHook, setReadOnly, showTrack, viewOf, type TrackMode } from './cm-diff';
import { getField, setField } from './core/frontmatter';
import { isSidecar, pushedStamp, repoFilePath, sidecarPath, submitTagName } from './core/repo';
import { computeMarks, criticExcerpts, describeStats, markStats, type Excerpt } from './core/track';
import { createTag, getFile, putFile, type GitHubConfig } from './github';
import { confirm, editCommitMessage, proceedOrAbort, promptText } from './modals';
import type MarkupReviewerPlugin from './main';

const MODES: TrackMode[] = ['original', 'markup', 'final'];
const MODE_LABEL: Record<TrackMode, string> = {
	original: 'Original',
	markup: 'Markup',
	final: 'Final',
};
const MAX_PASTES = 200;
const REFRESH_MS = 250;

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** The note's `submitstamp:` value, or null when it is missing, empty or a YAML null. */
function submitStamp(text: string): string | null {
	const v = getField(text, 'submitstamp')?.trim() ?? '';
	return v === '' || v === '~' || v.toLowerCase() === 'null' ? null : v;
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

export class EditTracker {
	/** Original text by note path (the sidecar's contents). */
	private originals = new Map<string, string>();
	/** Notes with a check or push in progress, so a double click can't push twice. */
	private busy = new Set<string>();
	private pending = new Set<string>();
	private timer: number | null = null;
	private statusEl: HTMLElement | null = null;
	/** Header buttons added to tracked notes' views (the mobile entry points). */
	private actions = new WeakMap<MarkdownView, HTMLElement[]>();
	/** Views whose editor currently shows track marks, to clear them when tracking stops. */
	private marked = new WeakSet<EditorView>();

	constructor(private readonly plugin: MarkupReviewerPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	private get settings() {
		return this.plugin.settings;
	}

	// ── Wiring ──────────────────────────────────────────────────────────

	load(): void {
		const p = this.plugin;
		this.statusEl = p.addStatusBarItem();
		this.statusEl.addClass('markup-reviewer-status');

		setPasteHook((view, texts) => this.onPaste(view, texts));
		p.register(() => setPasteHook(null));
		p.register(() => {
			if (this.timer !== null) window.clearTimeout(this.timer);
		});

		// Obsidian handles pastes and drops itself, and the text it inserts doesn't
		// carry CodeMirror's paste label, so take the text from Obsidian's own
		// events too. They fire for every paste or drop, whatever the display mode.
		p.registerEvent(
			// eslint-disable-next-line obsidianmd/editor-drop-paste -- only observes the text; the paste must go ahead unchanged
			this.app.workspace.on('editor-paste', (evt, _editor, info) => {
				const text = evt.clipboardData?.getData('text/plain');
				if (text) this.recordPastes(info.file?.path, [text]);
			}),
		);
		p.registerEvent(
			// eslint-disable-next-line obsidianmd/editor-drop-paste -- only observes the text; the paste must go ahead unchanged
			this.app.workspace.on('editor-drop', (evt, _editor, info) => {
				const text = evt.dataTransfer?.getData('text/plain');
				if (text) this.recordPastes(info.file?.path, [text]);
			}),
		);

		p.registerEvent(
			this.app.workspace.on('editor-change', (_editor, info) => {
				const path = info.file?.path;
				if (path && this.isTracked(path)) this.schedule(path);
			}),
		);
		p.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshAll()));
		p.registerEvent(this.app.workspace.on('layout-change', () => this.refreshAll()));
		p.registerEvent(this.app.workspace.on('file-open', () => this.refreshAll()));

		p.registerEvent(
			this.app.vault.on('modify', (file) => {
				// The original was edited by hand: re-read it.
				for (const path of Object.keys(this.settings.tracking)) {
					if (file.path === sidecarPath(path, this.settings.originalSuffix)) {
						this.originals.delete(path);
						this.schedule(path);
					}
				}
				if (this.isTracked(file.path)) this.schedule(file.path);
			}),
		);
		p.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				const st = this.settings.tracking[oldPath];
				if (!st || !(file instanceof TFile)) return;
				delete this.settings.tracking[oldPath];
				this.settings.tracking[file.path] = st;
				const text = this.originals.get(oldPath);
				this.originals.delete(oldPath);
				if (text !== undefined) this.originals.set(file.path, text);
				const oldSide = this.app.vault.getFileByPath(
					sidecarPath(oldPath, this.settings.originalSuffix),
				);
				if (oldSide) {
					void this.app.fileManager.renameFile(
						oldSide,
						sidecarPath(file.path, this.settings.originalSuffix),
					);
				}
				void this.plugin.saveSettings();
				this.refreshAll();
			}),
		);
		p.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (!this.settings.tracking[file.path]) return;
				delete this.settings.tracking[file.path];
				this.originals.delete(file.path);
				void this.plugin.saveSettings();
				this.refreshAll();
			}),
		);

		this.app.workspace.onLayoutReady(() => this.refreshAll());
	}

	/** Remove every mark and read-only lock (plugin unload). */
	unload(): void {
		for (const mv of this.markdownViews()) {
			const v = viewOf(mv.editor);
			if (v && this.marked.has(v)) {
				showTrack(v, null);
				setReadOnly(v, false);
			}
			for (const el of this.actions.get(mv) ?? []) el.remove();
		}
		this.markTabs(true);
	}

	/**
	 * The note being tracked. Only one note is tracked at a time: the panel and
	 * Stop / Pause / Discard lock onto it until the session ends, whichever note is active.
	 */
	lockedFile(): TFile | null {
		for (const path of Object.keys(this.settings.tracking)) {
			const f = this.app.vault.getFileByPath(path);
			if (f) return f;
		}
		return null;
	}

	/** A routine progress notice: shown only when "Show progress notices" is on. */
	private info(message: string): void {
		if (this.settings.progressNotices) new Notice(message);
	}

	isTracked(path: string | undefined | null): boolean {
		return !!path && !!this.settings.tracking[path];
	}

	/** Tracked and not paused: marks drawn, pastes recorded, tab red. */
	isActive(path: string | undefined | null): boolean {
		return !!path && !!this.settings.tracking[path] && !this.settings.tracking[path].paused;
	}

	isPaused(path: string | undefined | null): boolean {
		return !!path && !!this.settings.tracking[path]?.paused;
	}

	// ── Display ─────────────────────────────────────────────────────────

	get mode(): TrackMode {
		return this.settings.trackMode;
	}

	async setMode(mode: TrackMode): Promise<void> {
		this.settings.trackMode = mode;
		await this.plugin.saveSettings();
		this.refreshAll();
	}

	async cycleMode(): Promise<void> {
		const next = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
		await this.setMode(next);
		this.info(`Markup Reviewer: showing the ${MODE_LABEL[next]}.`);
	}

	private markdownViews(): MarkdownView[] {
		return this.app.workspace
			.getLeavesOfType('markdown')
			.map((l) => l.view)
			.filter((v): v is MarkdownView => v instanceof MarkdownView);
	}

	private schedule(path: string): void {
		this.pending.add(path);
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			const paths = [...this.pending];
			this.pending.clear();
			for (const p of paths) void this.refreshPath(p);
		}, REFRESH_MS);
	}

	/** Recompute and redraw the marks in every editor showing `path`. */
	private async refreshPath(path: string): Promise<void> {
		const views = this.markdownViews().filter((v) => v.file?.path === path);
		if (views.length === 0) return;
		const original = this.isActive(path) ? await this.loadOriginal(path) : null;
		for (const mv of views) this.paint(mv, original);
		this.updateStatus();
	}

	private paint(mv: MarkdownView, original: string | null): void {
		const v = viewOf(mv.editor);
		if (!v) return;
		const path = mv.file?.path;
		const st = path ? this.settings.tracking[path] : undefined;
		if (!st || st.paused || original === null) {
			if (this.marked.has(v)) {
				showTrack(v, null);
				setReadOnly(v, false);
				this.marked.delete(v);
			}
			this.syncActions(mv, false);
			return;
		}
		const marks = computeMarks(original, mv.editor.getValue(), st.pastes);
		showTrack(v, { marks, mode: this.mode });
		setReadOnly(v, this.mode === 'original');
		this.marked.add(v);
		this.syncActions(mv, true);
	}

	refreshAll(): void {
		const paths = new Set<string>();
		for (const mv of this.markdownViews()) {
			const path = mv.file?.path;
			if (!path) continue;
			if (this.isActive(path)) paths.add(path);
			else this.paint(mv, null);
		}
		for (const p of paths) void this.refreshPath(p);
		this.markTabs();
		this.updateStatus();
	}

	/**
	 * Turn the tab of every pane showing the tracked note red. Uses the leaf's
	 * tab header element, which Obsidian doesn't expose in its typings.
	 */
	private markTabs(clearAll = false): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const tab = (leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
			if (!tab) return;
			const v = leaf.view;
			const tracked = !clearAll && v instanceof MarkdownView && this.isActive(v.file?.path ?? null);
			tab.toggleClass('markup-reviewer-tracked-tab', tracked);
		});
	}

	/** Header buttons on tracked notes: cycle the display, and Stop (push). Also the mobile entry points. */
	private syncActions(mv: MarkdownView, tracked: boolean): void {
		const have = this.actions.get(mv);
		if (tracked && !have) {
			const done = mv.addAction('upload-cloud', 'Stop: commit and push to GitHub', () => {
				if (mv.file) void this.stop(mv.file);
			});
			const cycle = mv.addAction('git-compare', 'Show original, markup or final', () => {
				void this.cycleMode();
			});
			this.actions.set(mv, [done, cycle]);
		} else if (!tracked && have) {
			for (const el of have) el.remove();
			this.actions.delete(mv);
		}
	}

	private updateStatus(): void {
		this.plugin.refreshTrackBar();
		const el = this.statusEl;
		if (!el) return;
		el.empty();
		const file = this.app.workspace.getActiveFile();
		if (!file || !this.isActive(file.path)) {
			el.hide();
			return;
		}
		el.show();
		const icon = el.createSpan({ cls: 'markup-reviewer-status-icon' });
		setIcon(icon, 'git-compare');
		for (const m of MODES) {
			const b = el.createSpan({ cls: 'markup-reviewer-status-mode', text: MODE_LABEL[m] });
			if (m === this.mode) b.addClass('is-active');
			b.setAttribute('aria-label', `Show the ${MODE_LABEL[m].toLowerCase()}`);
			b.addEventListener('click', () => void this.setMode(m));
		}
		const push = el.createSpan({ cls: 'markup-reviewer-status-push', text: 'Push' });
		push.setAttribute('aria-label', 'Stop: commit and push to GitHub');
		push.addEventListener('click', () => void this.stop(file));
	}

	/** A paste, drop or drag-move seen by CodeMirror (e.g. Virtual Outliner's outline drags). */
	private onPaste(view: EditorView, texts: string[]): void {
		const mv = this.markdownViews().find((m) => viewOf(m.editor) === view);
		this.recordPastes(mv?.file?.path, texts);
	}

	/** Remember pasted or dropped texts as hints for spotting moves and copies. */
	private recordPastes(path: string | undefined, texts: string[]): void {
		const st = path ? this.settings.tracking[path] : undefined;
		if (!st || st.paused) return;
		for (const t of texts) if (t.trim().length >= 3) st.pastes.push(t);
		if (st.pastes.length > MAX_PASTES) st.pastes.splice(0, st.pastes.length - MAX_PASTES);
		this.plugin.saveSessionSoon();
	}

	// ── Files ───────────────────────────────────────────────────────────

	private openView(path: string): MarkdownView | null {
		return this.markdownViews().find((v) => v.file?.path === path) ?? null;
	}

	/** The note's current text, preferring the open editor (it may hold unsaved keystrokes). */
	private async currentText(file: TFile): Promise<string> {
		const mv = this.openView(file.path);
		return mv ? mv.editor.getValue() : this.app.vault.read(file);
	}

	private async loadOriginal(path: string): Promise<string | null> {
		const cached = this.originals.get(path);
		if (cached !== undefined) return cached;
		const side = this.app.vault.getFileByPath(sidecarPath(path, this.settings.originalSuffix));
		if (!side) return null;
		const text = await this.app.vault.read(side);
		this.originals.set(path, text);
		return text;
	}

	private async writeOriginal(file: TFile, text: string): Promise<void> {
		const path = sidecarPath(file.path, this.settings.originalSuffix);
		this.originals.set(file.path, text);
		const side = this.app.vault.getFileByPath(path);
		if (side) await this.app.vault.modify(side, text);
		else await this.app.vault.create(path, text);
		this.originals.set(file.path, text);
	}

	/**
	 * Set one frontmatter field, touching only its line. Goes through the open
	 * editor when there is one (keeping the cursor and undo history), then saves.
	 */
	private async writeField(file: TFile, key: string, value: string): Promise<void> {
		const mv = this.openView(file.path);
		if (mv) {
			const ed: Editor = mv.editor;
			const before = ed.getValue();
			const after = setField(before, key, value);
			if (after === before) return;
			let p = 0;
			while (p < before.length && before[p] === after[p]) p++;
			let s = 0;
			while (
				s < before.length - p &&
				s < after.length - p &&
				before[before.length - 1 - s] === after[after.length - 1 - s]
			)
				s++;
			ed.replaceRange(
				after.slice(p, after.length - s),
				ed.offsetToPos(p),
				ed.offsetToPos(before.length - s),
			);
			await mv.save();
			return;
		}
		await this.app.vault.process(file, (t) => setField(t, key, value));
	}

	private githubConfig(): GitHubConfig | null {
		const id = this.settings.githubTokenSecret;
		const token = id ? this.app.secretStorage.getSecret(id) : null;
		if (!token) {
			new Notice(
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Markup Reviewer" is the plugin's name
				'Markup Reviewer: no GitHub token found. Set the GitHub token secret in the plugin settings.',
			);
			return null;
		}
		return { token, repo: this.settings.githubRepo, branch: this.settings.githubBranch || 'main' };
	}

	/**
	 * Stamp `pushed:`, save, and push the note. On failure the stamp is put back
	 * and the exact error shown. Returns the pushed text and its new SHA.
	 */
	private async pushNote(
		file: TFile,
		cfg: GitHubConfig,
		repoPath: string,
		message: string,
		sha: string | null,
	): Promise<{ text: string; sha: string; commit: string | null } | null> {
		const prev = getField(await this.currentText(file), 'pushed');
		await this.writeField(file, 'pushed', pushedStamp(new Date()));
		const text = await this.currentText(file);
		try {
			const put = await putFile(cfg, repoPath, text, message, sha);
			return { text, sha: put.sha, commit: put.commit };
		} catch (e) {
			await this.writeField(file, 'pushed', prev ?? '');
			const msg = errText(e);
			new Notice(`Markup Reviewer: push failed. ${msg}`, 15000);
			return null;
		}
	}

	// ── Commands ────────────────────────────────────────────────────────

	/** Start tracking: make sure GitHub has the original, then cache it next to the note. */
	async start(file: TFile): Promise<void> {
		if (isSidecar(file.path, this.settings.originalSuffix)) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Markup Reviewer" is the plugin's name
			new Notice('Markup Reviewer: this is the copy of an original. Open the note itself.');
			return;
		}
		if (this.isTracked(file.path)) {
			new Notice(`Markup Reviewer: ${file.name} is already being tracked.`);
			this.refreshAll();
			return;
		}
		const locked = this.lockedFile();
		if (locked) {
			new Notice(
				`Markup Reviewer: already tracking ${locked.name}. Click Stop on it (or run Discard tracking without pushing) before tracking another note.`,
			);
			return;
		}
		const cfg = this.githubConfig();
		if (!cfg || this.busy.has(file.path)) return;
		this.busy.add(file.path);
		try {
			let git = getField(await this.currentText(file), 'git');
			if (!git) {
				const folder = file.parent && file.parent.path !== '/' ? `${file.parent.path}/` : '';
				const v = await promptText(
					this.app,
					'Where on GitHub?',
					`This note has no git: path. Which folder in ${cfg.repo} should it live in?`,
					folder,
					'Use this folder',
				);
				if (v === null) return;
				git = v;
				await this.writeField(file, 'git', v);
			}
			const repoPath = repoFilePath(git, file.name);
			if (!repoPath) return;

			this.info(`Markup Reviewer: checking GitHub for ${repoPath}…`);
			let remote;
			try {
				remote = await getFile(cfg, repoPath);
			} catch (e) {
				new Notice(`Markup Reviewer: ${errText(e)}`, 15000);
				return;
			}

			let original: string;
			let sha: string;
			if (remote) {
				original = remote.text;
				sha = remote.sha;
			} else {
				const ok = await confirm(
					this.app,
					'Not on GitHub yet',
					`${file.name} isn't in ${cfg.repo} at ${repoPath}. Push the current version as the original? Your edits will be tracked from there.`,
					'Push as original',
				);
				if (!ok) return;
				const res = await this.pushNote(file, cfg, repoPath, `Add ${file.name}`, null);
				if (!res) return;
				original = res.text;
				sha = res.sha;
				this.info(`Markup Reviewer: pushed ${file.name} to ${cfg.repo} (${shortSha(sha)}).`);
			}

			await this.writeOriginal(file, original);
			this.settings.tracking[file.path] = {
				repoPath,
				sha,
				startedAt: new Date().toISOString(),
				pastes: [],
			};
			await this.plugin.saveSettings();
			this.refreshAll();
			this.info(`Markup Reviewer: tracking edits in ${file.name} against the GitHub copy.`);
		} finally {
			this.busy.delete(file.path);
		}
	}

	/**
	 * Stop: check GitHub, draft a commit message for approval (Approve and push,
	 * or Cancel to keep tracking), stamp, push, and end tracking.
	 */
	async stop(file: TFile): Promise<void> {
		const st = this.settings.tracking[file.path];
		if (!st) {
			new Notice(`Markup Reviewer: ${file.name} isn't being tracked. Start tracking it first.`);
			return;
		}
		const cfg = this.githubConfig();
		if (!cfg || this.busy.has(file.path)) return;
		this.busy.add(file.path);
		try {
			const original = await this.loadOriginal(file.path);
			if (original === null) {
				new Notice(
					`Markup Reviewer: the original (${sidecarPath(file.path, this.settings.originalSuffix)}) is missing. Run "Discard tracking without pushing" (your edits stay in the note), then Start again to fetch it from GitHub.`,
					15000,
				);
				return;
			}
			const text = await this.currentText(file);
			const marks = computeMarks(original, text, st.pastes);
			if (marks.length === 0) {
				// Nothing to push, so nothing can be lost: just end the session.
				await this.endTracking(file);
				new Notice(
					`Markup Reviewer: no changes in ${file.name} since the original, so nothing was pushed. Tracking ended.`,
				);
				return;
			}

			let remote;
			try {
				remote = await getFile(cfg, st.repoPath);
			} catch (e) {
				new Notice(`Markup Reviewer: ${errText(e)}`, 15000);
				return;
			}
			const remoteSha = remote?.sha ?? null;
			if (remoteSha !== st.sha) {
				const ok = await confirm(
					this.app,
					'GitHub copy has changed',
					remote
						? `The copy of ${file.name} on GitHub changed since you started tracking (it was pushed from somewhere else). Pushing will replace it with your version.`
						: `${file.name} is no longer on GitHub at ${st.repoPath}. Pushing will create it again.`,
					'Push anyway',
				);
				if (!ok) return;
			}

			const stats = describeStats(markStats(text, marks));
			const excerpts = criticExcerpts(text, marks);
			const changes = excerpts.map((x) => `Line ${x.line}: ${x.text}`).join('\n\n');
			const abort = new AbortController();
			const key = this.plugin.apiKey();
			const draft = key
				? draftCommitMessage({
						apiKey: key,
						model: this.settings.model,
						noteName: file.name,
						stats,
						changes,
						signal: abort.signal,
					})
				: Promise.reject(new Error('No Anthropic API key is set.'));
			const message = await editCommitMessage(this.app, {
				noteName: file.name,
				repoPath: st.repoPath,
				stats,
				draft,
				fallback: `Update ${file.basename} (${stats})`,
				abort,
			});
			if (message === null) return;

			const res = await this.pushNote(file, cfg, st.repoPath, message, remoteSha);
			if (!res) return;

			if (this.settings.changeLog) await this.appendChangeLog(file, message, res.sha, excerpts);
			await this.endTracking(file);
			this.info(
				`Markup Reviewer: pushed ${file.name} to ${cfg.repo} (${shortSha(res.sha)}). Tracking ended.`,
			);
			this.plugin.flashPushed();
		} finally {
			this.busy.delete(file.path);
		}
	}

	/**
	 * Sub: push the submitted version of a note with the commit message
	 * "Submitted version {submitstamp}". Aborts when `submitstamp:` is missing or
	 * empty, then asks Proceed | Abort (Abort is the default). After the push the
	 * commit is tagged `submitted/{note}/{submitstamp}` on GitHub. Works on any note
	 * with a `git:` path; a tracked note is pushed and its tracking ended, as Stop does.
	 */
	async submit(file: TFile): Promise<void> {
		if (isSidecar(file.path, this.settings.originalSuffix)) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Markup Reviewer" is the plugin's name
			new Notice('Markup Reviewer: this is the copy of an original. Open the note itself.');
			return;
		}
		const text = await this.currentText(file);
		const stamp = submitStamp(text);
		if (stamp === null) {
			new Notice(
				`Markup Reviewer: ${file.name} has no submitstamp: value, so it wasn't submitted. Fill in submitstamp: and click Sub again.`,
				10000,
			);
			return;
		}
		const st = this.settings.tracking[file.path];
		let repoPath: string | null;
		if (st) repoPath = st.repoPath;
		else {
			const git = getField(text, 'git');
			repoPath = git ? repoFilePath(git, file.name) : null;
			if (!repoPath) {
				new Notice(
					`Markup Reviewer: ${file.name} has no git: path, so there's nowhere to submit it. Fill in git: (or Start tracking it) first.`,
					10000,
				);
				return;
			}
		}
		const cfg = this.githubConfig();
		if (!cfg || this.busy.has(file.path)) return;
		this.busy.add(file.path);
		try {
			const message = `Submitted version ${stamp}`;
			const ok = await proceedOrAbort(
				this.app,
				'Submit this version?',
				`Push ${file.name} to ${cfg.repo} at ${repoPath} with the comment "${message}", then tag it ${submitTagName(file.basename, stamp)}.${st ? ' Tracking ends after the push.' : ''}`,
			);
			if (!ok) return;

			let remote;
			try {
				remote = await getFile(cfg, repoPath);
			} catch (e) {
				new Notice(`Markup Reviewer: ${errText(e)}`, 15000);
				return;
			}
			const remoteSha = remote?.sha ?? null;
			if (st && remoteSha !== st.sha) {
				const go = await confirm(
					this.app,
					'GitHub copy has changed',
					remote
						? `The copy of ${file.name} on GitHub changed since you started tracking (it was pushed from somewhere else). Submitting will replace it with your version.`
						: `${file.name} is no longer on GitHub at ${repoPath}. Submitting will create it again.`,
					'Push anyway',
				);
				if (!go) return;
			}

			// Excerpts for the change log, taken before the push stamps `pushed:`.
			const original = st ? await this.loadOriginal(file.path) : null;
			let excerpts: Excerpt[] = [];
			if (st && original !== null) {
				const before = await this.currentText(file);
				excerpts = criticExcerpts(before, computeMarks(original, before, st.pastes));
			}

			const res = await this.pushNote(file, cfg, repoPath, message, remoteSha);
			if (!res) return;

			const tag = await this.tagSubmission(file, cfg, stamp, message, res.commit);

			if (st) {
				if (this.settings.changeLog && excerpts.length > 0)
					await this.appendChangeLog(file, message, res.sha, excerpts);
				await this.endTracking(file);
			}
			this.info(
				`Markup Reviewer: submitted ${file.name} to ${cfg.repo} (${shortSha(res.sha)})${tag ? `, tagged ${tag}` : ''}.${st ? ' Tracking ended.' : ''}`,
			);
			this.plugin.flashPushed();
		} finally {
			this.busy.delete(file.path);
		}
	}

	/**
	 * Tag the submit commit on GitHub as `submitted/{note}/{submitstamp}`, so the
	 * submitted version stays findable whatever is pushed later. The push has
	 * already succeeded, so a failure here only warns. Returns the tag, or null.
	 */
	private async tagSubmission(
		file: TFile,
		cfg: GitHubConfig,
		stamp: string,
		message: string,
		commit: string | null,
	): Promise<string | null> {
		const fail = (why: string) => {
			new Notice(
				`Markup Reviewer: submitted ${file.name}, but couldn't tag it on GitHub. ${why}`,
				15000,
			);
			return null;
		};
		if (!commit) return fail('GitHub did not return the commit SHA.');
		try {
			return await createTag(cfg, submitTagName(file.basename, stamp), commit, message);
		} catch (e) {
			return fail(errText(e));
		}
	}

	/** Pause: hide the marks and stop recording pastes, keeping the original. Nothing is pushed. */
	async pause(file: TFile): Promise<void> {
		const st = this.settings.tracking[file.path];
		if (!st || st.paused) return;
		st.paused = true;
		await this.plugin.saveSettings();
		this.refreshAll();
		this.info(`Markup Reviewer: tracking paused in ${file.name}. Nothing was pushed.`);
	}

	/** Resume a paused session: the marks come back against the same original. */
	async resume(file: TFile): Promise<void> {
		const st = this.settings.tracking[file.path];
		if (!st || !st.paused) return;
		st.paused = false;
		await this.plugin.saveSettings();
		this.refreshAll();
		this.info(`Markup Reviewer: tracking resumed in ${file.name}.`);
	}

	async togglePause(file: TFile): Promise<void> {
		if (this.isPaused(file.path)) await this.resume(file);
		else await this.pause(file);
	}

	/**
	 * Discard the session without pushing: clear the marks and move the copy of
	 * the original to the trash. The note keeps its edits; GitHub is untouched.
	 */
	async discard(file: TFile): Promise<void> {
		if (!this.isTracked(file.path)) {
			new Notice(`Markup Reviewer: ${file.name} isn't being tracked.`);
			return;
		}
		const sidePath = sidecarPath(file.path, this.settings.originalSuffix);
		const ok = await confirm(
			this.app,
			'Discard tracking without pushing?',
			`The marks in ${file.name} disappear and ${sidePath} moves to the trash. Nothing is pushed: your note keeps your edits, and the copy on GitHub is not changed.`,
			'Discard without pushing',
		);
		if (!ok) return;
		await this.endTracking(file);
	}

	/** End the session: forget the note, clear its marks, unlock the panel, trash the copy of the original. */
	private async endTracking(file: TFile): Promise<void> {
		delete this.settings.tracking[file.path];
		this.originals.delete(file.path);
		await this.plugin.saveSettings();
		const side = this.app.vault.getFileByPath(sidecarPath(file.path, this.settings.originalSuffix));
		if (side) await this.app.fileManager.trashFile(side);
		this.refreshAll();
	}

	private async appendChangeLog(
		file: TFile,
		message: string,
		sha: string,
		excerpts: Excerpt[],
	): Promise<void> {
		const dir = file.parent && file.parent.path !== '/' ? `${file.parent.path}/` : '';
		const path = `${dir}${file.basename} Changes.md`;
		const d = new Date();
		const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		const fence = '````';
		const body = excerpts
			.map((x) => `**Line ${x.line}**\n\n${fence}criticmarkup\n${x.text}\n${fence}`)
			.join('\n\n');
		const entry = `\n## ${stamp} · ${shortSha(sha)}\n\n${message}\n\n### Changes\n\n${body}\n`;
		try {
			const log = this.app.vault.getFileByPath(path);
			if (log) await this.app.vault.append(log, entry);
			else await this.app.vault.create(path, `# ${file.basename} change log\n${entry}`);
		} catch (e) {
			new Notice(
				`Markup Reviewer: pushed, but couldn't write the change log: ${errText(e)}`,
				15000,
			);
		}
	}
}
