import { App, Modal, Platform, Setting } from 'obsidian';
import { NOTE_COLOURS, NoteColour, parseTags } from '../../notes/noteFormat';
import { quotePreview } from './noteCard';

export interface CommentValues {
	colour: NoteColour;
	body: string;
	tags: string[];
}

const COLOUR_NAMES: Record<NoteColour, string> = {
	yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', red: 'Red',
};

/**
 * Asks for a margin note: a highlight colour, optional text and tags. An
 * empty note is a bare highlight.
 */
export class CommentModal extends Modal {
	private values: CommentValues;
	private swatches = new Map<NoteColour, HTMLElement>();

	constructor(
		app: App,
		private quote: string,
		private onSubmit: (values: CommentValues) => void,
		initial?: Partial<CommentValues>,
		private heading = 'Comment',
	) {
		super(app);
		this.values = { colour: initial?.colour ?? 'yellow', body: initial?.body ?? '', tags: initial?.tags ?? [] };
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(this.heading);
		contentEl.addClass('heron-comment-modal');
		contentEl.createDiv({ cls: 'heron-note-quote', text: quotePreview(this.quote) });

		const colours = contentEl.createDiv({ cls: 'heron-colour-picker', attr: { role: 'radiogroup', 'aria-label': 'Highlight colour' } });
		for (const colour of NOTE_COLOURS) {
			const swatch = colours.createEl('button', {
				cls: `heron-colour-swatch heron-note-${colour}`,
				attr: { role: 'radio', 'aria-label': COLOUR_NAMES[colour], type: 'button' },
			});
			swatch.addEventListener('click', () => this.setColour(colour));
			this.swatches.set(colour, swatch);
		}
		this.setColour(this.values.colour);

		const body = contentEl.createEl('textarea', {
			cls: 'heron-comment-body',
			attr: { placeholder: 'Note (optional — leave empty for a highlight)', rows: 5 },
		});
		body.value = this.values.body;
		body.addEventListener('input', () => { this.values.body = body.value; });
		body.addEventListener('keydown', (evt) => {
			const mod = Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
			if (evt.key === 'Enter' && mod) {
				evt.preventDefault();
				this.submit();
			}
		});

		new Setting(contentEl)
			.setName('Tags')
			.addText((text) => text
				.setPlaceholder('For example: question, todo')
				.setValue(this.values.tags.map((t) => `#${t}`).join(' '))
				.onChange((value) => { this.values.tags = parseTags(value); }));

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((btn) => btn.setButtonText('Save').setCta().onClick(() => this.submit()));

		window.setTimeout(() => body.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}

	private setColour(colour: NoteColour) {
		this.values.colour = colour;
		for (const [c, el] of this.swatches) {
			el.toggleClass('is-active', c === colour);
			el.setAttr('aria-checked', c === colour ? 'true' : 'false');
		}
	}

	/** Saves and closes; exposed for tests. */
	submit() {
		this.close();
		this.onSubmit({ ...this.values, body: this.values.body.trim() });
	}
}
