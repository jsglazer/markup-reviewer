import { App, FuzzySuggestModal, Modal, Setting, TFile, type FuzzyMatch } from 'obsidian';

export interface PickedPdf {
	name: string;
	bytes: ArrayBuffer;
}

type Choice = { kind: 'browse' } | { kind: 'file'; file: TFile };

/** Pick a scanned PDF: vault PDFs (scan folder first, newest first) or Browse… for any file. */
class PdfPickerModal extends FuzzySuggestModal<Choice> {
	private chosen = false;

	constructor(
		app: App,
		private readonly scanFolder: string,
		private readonly done: (choice: Choice | null) => void,
	) {
		super(app);
		this.setPlaceholder('Pick the scanned PDF with your markup');
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to choose' },
			{ command: 'esc', purpose: 'to cancel' },
		]);
	}

	getItems(): Choice[] {
		const folder = this.scanFolder ? `${this.scanFolder}/` : '';
		const inFolder = (f: TFile): number => (folder && f.path.startsWith(folder) ? 0 : 1);
		const pdfs = this.app.vault
			.getFiles()
			.filter((f) => f.extension.toLowerCase() === 'pdf')
			.sort((a, b) => inFolder(a) - inFolder(b) || b.stat.mtime - a.stat.mtime);
		return [{ kind: 'browse' }, ...pdfs.map((file) => ({ kind: 'file' as const, file }))];
	}

	getItemText(item: Choice): string {
		return item.kind === 'browse' ? 'Browse for a PDF outside the vault…' : item.file.path;
	}

	renderSuggestion(match: FuzzyMatch<Choice>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		if (match.item.kind === 'browse') el.addClass('markup-reviewer-browse');
	}

	onChooseItem(item: Choice): void {
		this.chosen = true;
		this.done(item);
	}

	onClose(): void {
		super.onClose();
		// onChooseItem fires after close; wait a tick before reporting a cancel.
		window.setTimeout(() => {
			if (!this.chosen) this.done(null);
		}, 0);
	}
}

/** Show a native file chooser for a PDF. Resolves null if nothing was chosen. */
function browseForPdf(): Promise<PickedPdf | null> {
	return new Promise((resolve) => {
		const input = activeDocument.createElement('input');
		input.type = 'file';
		input.accept = 'application/pdf,.pdf';
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			if (!file) return resolve(null);
			file.arrayBuffer().then(
				(bytes) => resolve({ name: file.name, bytes }),
				() => resolve(null),
			);
		});
		input.addEventListener('cancel', () => resolve(null));
		input.click();
	});
}

export function pickPdf(app: App, scanFolder: string): Promise<PickedPdf | null> {
	return new Promise((resolve) => {
		new PdfPickerModal(app, scanFolder, (choice) => {
			if (!choice) return resolve(null);
			if (choice.kind === 'browse') {
				browseForPdf().then(resolve, () => resolve(null));
				return;
			}
			app.vault.readBinary(choice.file).then(
				(bytes) => resolve({ name: choice.file.name, bytes }),
				() => resolve(null),
			);
		}).open();
	});
}

export type ResumeChoice = 'resume' | 'new' | null;

/** A saved review exists for this note: resume it or read a new scan? */
export function askResume(app: App, pending: number, pdfName: string): Promise<ResumeChoice> {
	return new Promise((resolve) => {
		let answered = false;
		const modal = new Modal(app);
		modal.setTitle('Saved markup review');
		modal.contentEl.createEl('p', {
			text: `This note has a saved review of "${pdfName}" with ${pending} pending edit${pending === 1 ? '' : 's'}.`,
		});
		const finish = (c: ResumeChoice): void => {
			answered = true;
			resolve(c);
			modal.close();
		};
		new Setting(modal.contentEl)
			.addButton((b) =>
				b
					.setButtonText('Resume review')
					.setCta()
					.onClick(() => finish('resume')),
			)
			.addButton((b) => b.setButtonText('Read a new scan').onClick(() => finish('new')))
			.addButton((b) => b.setButtonText('Cancel').onClick(() => finish(null)));
		modal.onClose = () => {
			if (!answered) resolve(null);
		};
		modal.open();
	});
}

/** Simple yes/no confirmation. */
export function confirm(app: App, title: string, body: string, yes: string): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const modal = new Modal(app);
		modal.setTitle(title);
		modal.contentEl.createEl('p', { text: body });
		new Setting(modal.contentEl)
			.addButton((b) =>
				b
					.setButtonText(yes)
					.setCta()
					.onClick(() => {
						answered = true;
						resolve(true);
						modal.close();
					}),
			)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => modal.close()));
		modal.onClose = () => {
			if (!answered) resolve(false);
		};
		modal.open();
	});
}
