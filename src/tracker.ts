/**
 * Manual edit tracking: the note always holds your current text, the original
 * is the copy on GitHub (cached in a visible file next to the note), and the
 * red/green/purple marks are recomputed by comparing the two shortly after
 * every change. "Done" checks GitHub, has Claude draft a commit message for
 * you to edit or approve, stamps `pushed:`, and pushes the note.
 */
import { MarkdownView, Notice, TFile, setIcon, type Editor } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { draftCommitMessage } from './claude';
import { setPasteHook, setReadOnly, showTrack, viewOf, type TrackMode } from './cm-diff';
import { getField, setField } from './core/frontmatter';
import { isSidecar, pushedStamp, repoFilePath, sidecarPath } from './core/repo';
import { computeMarks, criticExcerpts, describeStats, markStats, type Excerpt } from './core/track';
import { getFile, putFile, type GitHubConfig } from './github';
import { confirm, editCommitMessage, promptText } from './modals';
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
	}

	isTracked(path: string | undefined | null): boolean {
		return !!path && !!this.settings.tracking[path];
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
		new Notice(`Markup Reviewer: showing the ${MODE_LABEL[next]}.`);
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
		const original = this.isTracked(path) ? await this.loadOriginal(path) : null;
		for (const mv of views) this.paint(mv, original);
		this.updateStatus();
	}

	private paint(mv: MarkdownView, original: string | null): void {
		const v = viewOf(mv.editor);
		if (!v) return;
		const path = mv.file?.path;
		const st = path ? this.settings.tracking[path] : undefined;
		if (!st || original === null) {
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
			if (this.isTracked(path)) paths.add(path);
			else this.paint(mv, null);
		}
		for (const p of paths) void this.refreshPath(p);
		this.updateStatus();
	}

	/** Header buttons on tracked notes: cycle the display, and Done. Also the mobile entry points. */
	private syncActions(mv: MarkdownView, tracked: boolean): void {
		const have = this.actions.get(mv);
		if (tracked && !have) {
			const done = mv.addAction('upload-cloud', 'Done: commit and push to GitHub', () => {
				if (mv.file) void this.done(mv.file);
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
		const el = this.statusEl;
		if (!el) return;
		el.empty();
		const file = this.app.workspace.getActiveFile();
		if (!file || !this.isTracked(file.path)) {
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
		push.setAttribute('aria-label', 'Done: commit and push to GitHub');
		push.addEventListener('click', () => void this.done(file));
	}

	private onPaste(view: EditorView, texts: string[]): void {
		const mv = this.markdownViews().find((m) => viewOf(m.editor) === view);
		const path = mv?.file?.path;
		const st = path ? this.settings.tracking[path] : undefined;
		if (!st) return;
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
	): Promise<{ text: string; sha: string } | null> {
		const prev = getField(await this.currentText(file), 'pushed');
		await this.writeField(file, 'pushed', pushedStamp(new Date()));
		const text = await this.currentText(file);
		try {
			const newSha = await putFile(cfg, repoPath, text, message, sha);
			return { text, sha: newSha };
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

			new Notice(`Markup Reviewer: checking GitHub for ${repoPath}…`);
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
				new Notice(`Markup Reviewer: pushed ${file.name} to ${cfg.repo} (${shortSha(sha)}).`);
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
			new Notice(`Markup Reviewer: tracking edits in ${file.name} against the GitHub copy.`);
		} finally {
			this.busy.delete(file.path);
		}
	}

	/** Done: check GitHub, draft a commit message for approval, stamp and push. */
	async done(file: TFile): Promise<void> {
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
					`Markup Reviewer: the original (${sidecarPath(file.path, this.settings.originalSuffix)}) is missing. Stop tracking and start again to fetch it from GitHub.`,
					15000,
				);
				return;
			}
			const text = await this.currentText(file);
			const marks = computeMarks(original, text, st.pastes);
			if (marks.length === 0) {
				new Notice(`Markup Reviewer: no changes in ${file.name} since the original.`);
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

			await this.writeOriginal(file, res.text);
			st.sha = res.sha;
			st.pastes = [];
			await this.plugin.saveSettings();
			if (this.settings.changeLog) await this.appendChangeLog(file, message, res.sha, excerpts);
			this.refreshAll();
			new Notice(`Markup Reviewer: pushed ${file.name} to ${cfg.repo} (${shortSha(res.sha)}).`);
		} finally {
			this.busy.delete(file.path);
		}
	}

	/** Stop tracking: clear the marks and move the copy of the original to the trash. */
	async stop(file: TFile): Promise<void> {
		if (!this.isTracked(file.path)) {
			new Notice(`Markup Reviewer: ${file.name} isn't being tracked.`);
			return;
		}
		const sidePath = sidecarPath(file.path, this.settings.originalSuffix);
		const ok = await confirm(
			this.app,
			'Stop tracking edits?',
			`The marks in ${file.name} disappear and ${sidePath} moves to the trash. Your note and the copy on GitHub are not changed.`,
			'Stop tracking',
		);
		if (!ok) return;
		delete this.settings.tracking[file.path];
		this.originals.delete(file.path);
		await this.plugin.saveSettings();
		const side = this.app.vault.getFileByPath(sidePath);
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
