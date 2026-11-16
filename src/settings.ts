import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type MarkupReviewerPlugin from './main';
import type { ReviewSession } from './core/types';
import type { TrackMode } from './cm-diff';

/** A note whose manual edits are being tracked against its GitHub original. */
export interface TrackState {
	/** File path in the repo the note pushes to. */
	repoPath: string;
	/** Blob SHA of the original on GitHub (null if it wasn't there). */
	sha: string | null;
	startedAt: string;
	/** Texts recently pasted or dropped into the note: hints for detecting moves. */
	pastes: string[];
	/** Paused: marks hidden and pastes not recorded; the original is kept and nothing is pushed. */
	paused?: boolean;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface MarkupReviewerSettings {
	/** Name of the secret in Obsidian's SecretStorage that holds the API key (never the key itself). */
	apiKeySecret: string;
	model: string;
	effort: Effort;
	/** How many implemented edits the panel's Undo can step back through (minimum 5). */
	undoLevels: number;
	/** Keep implemented edits highlighted green in the note until cleared. */
	keepTrail: boolean;
	/** Move to the next pending edit after Implement or Skip. */
	autoAdvance: boolean;
	/** Vault folder the PDF picker lists first (blank = whole vault). */
	scanFolder: string;
	/** Review sessions by note path, so closing the panel or Obsidian doesn't lose progress. */
	sessions: Record<string, ReviewSession>;
	/** Name of the secret in Obsidian's SecretStorage holding the GitHub token. */
	githubTokenSecret: string;
	/** `owner/name` of the repo tracked notes push to. */
	githubRepo: string;
	githubBranch: string;
	/** Appended to the note's name for the local copy of the original. */
	originalSuffix: string;
	/** Append each push's message and changes to `{note} Changes.md`. */
	changeLog: boolean;
	/** Pop up progress notices (checking GitHub, tracking started/paused/resumed, pushed). Problems always show. */
	progressNotices: boolean;
	/** How tracked edits are displayed. */
	trackMode: TrackMode;
	/** Tracked notes by path. */
	tracking: Record<string, TrackState>;
}

export const DEFAULT_SETTINGS: MarkupReviewerSettings = {
	apiKeySecret: 'anthropic-api-key',
	model: 'claude-opus-5-5',
	effort: 'high',
	undoLevels: 20,
	keepTrail: true,
	autoAdvance: true,
	scanFolder: '',
	sessions: {},
	githubTokenSecret: 'github-papers-token',
	githubRepo: 'jsglazer/papers',
	githubBranch: 'main',
	originalSuffix: '.original.md',
	changeLog: false,
	progressNotices: false,
	trackMode: 'markup',
	tracking: {},
};

const MODELS: Record<string, string> = {
	'claude-opus-5-5': 'Claude Opus 5.5 (default)',
	'claude-sonnet-5-5': 'Claude Sonnet 5.5',
	'claude-fable-5-1': 'Claude Fable 5.1',
	'claude-haiku-5-5': 'Claude Haiku 5.5',
};

const EFFORTS: Record<Effort, string> = {
	low: 'Low',
	medium: 'Medium',
	high: 'High (default)',
	xhigh: 'Extra high',
	max: 'Max',
};

export class MarkupReviewerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: MarkupReviewerPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName('Anthropic API key')
			.setDesc(
				"Pick or create a secret in Obsidian's keychain. Only the secret's name is saved in the plugin settings; the key itself never is.",
			)
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(s.apiKeySecret).onChange(async (value) => {
					s.apiKeySecret = value ?? '';
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Claude model that reads the handwriting. It must accept PDF input.')
			.addDropdown((d) => {
				for (const [id, label] of Object.entries(MODELS)) d.addOption(id, label);
				if (!(s.model in MODELS)) d.addOption(s.model, s.model);
				d.setValue(s.model).onChange(async (value) => {
					s.model = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Effort')
			.setDesc(
				'How hard the model thinks. Higher reads messy handwriting better, but is slower and costs more.',
			)
			.addDropdown((d) => {
				for (const [id, label] of Object.entries(EFFORTS)) d.addOption(id, label);
				d.setValue(s.effort).onChange(async (value) => {
					s.effort = value as Effort;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Scan folder')
			.setDesc(
				'Vault folder whose PDF files the picker lists first. Leave blank to list every PDF in the vault.',
			)
			.addText((t) =>
				t
					.setPlaceholder('Scans')
					.setValue(s.scanFolder)
					.onChange(async (value) => {
						s.scanFolder = value.trim().replace(/^\/+|\/+$/g, '');
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Undo levels')
			.setDesc('How many implemented edits the panel can undo, newest first. Minimum 5.')
			.addSlider((sl) =>
				sl
					.setLimits(5, 100, 1)
					.setValue(s.undoLevels)
					.onChange(async (value) => {
						s.undoLevels = value;
						this.plugin.onUndoLevelsChanged();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Keep implemented edits highlighted')
			.setDesc(
				'Leave a green highlight on each implemented edit (and the struck text it replaced) until you clear marks or close the review. Display only: nothing extra is written into the note.',
			)
			.addToggle((t) =>
				t.setValue(s.keepTrail).onChange(async (value) => {
					s.keepTrail = value;
					await this.plugin.saveSettings();
					this.plugin.refreshView();
				}),
			);

		new Setting(containerEl)
			.setName('Advance automatically')
			.setDesc(
				'After you implement or skip an edit, select the next pending one and scroll the note to it.',
			)
			.addToggle((t) =>
				t.setValue(s.autoAdvance).onChange(async (value) => {
					s.autoAdvance = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Track manual edits').setHeading();

		new Setting(containerEl)
			.setName('GitHub token')
			.setDesc(
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Contents" is GitHub's permission name
				"A fine-grained personal access token with Contents read and write access to the repository below, kept in Obsidian's keychain.",
			)
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(s.githubTokenSecret).onChange(async (value) => {
					s.githubTokenSecret = value ?? '';
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Repository')
			.setDesc(
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "git:" is the literal frontmatter field
				"Where tracked notes are pushed, as owner/name. The note's git: field is the folder inside it.",
			)
			.addText((t) =>
				t
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal format, not prose
					.setPlaceholder('owner/name')
					.setValue(s.githubRepo)
					.onChange(async (value) => {
						s.githubRepo = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Branch').addText((t) =>
			t
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal branch name
				.setPlaceholder('main')
				.setValue(s.githubBranch)
				.onChange(async (value) => {
					s.githubBranch = value.trim() || 'main';
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl)
			.setName('Original file suffix')
			.setDesc(
				'The GitHub original is kept next to the note under this name, e.g. Final.original.md. You can open and edit it by hand.',
			)
			.addText((t) =>
				t
					.setPlaceholder('.original.md')
					.setValue(s.originalSuffix)
					.onChange(async (value) => {
						const v = value.trim();
						s.originalSuffix = v && v !== '.md' ? v : '.original.md';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Keep a change log')
			.setDesc(
				'After each push, append the commit message and the changes (in CriticMarkup) to a "{note} Changes" note next to the note.',
			)
			.addToggle((t) =>
				t.setValue(s.changeLog).onChange(async (value) => {
					s.changeLog = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Show progress notices')
			.setDesc(
				'Pop up a notice for routine steps: checking GitHub, tracking started, paused or resumed, the display switched, and a successful push. Problems and warnings always show. When off, the review panel flashes green after a push.',
			)
			.addToggle((t) =>
				t.setValue(s.progressNotices).onChange(async (value) => {
					s.progressNotices = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
