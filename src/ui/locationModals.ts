import { App, FuzzySuggestModal, SuggestModal } from 'obsidian';
import type { FileLocation } from '../lsp/locations';

/** A location shown in a picker: a title (symbol or `file:line`) and a muted detail line. */
export interface LocationItem extends FileLocation {
	title: string;
	detail: string;
}

function renderItem(item: LocationItem, el: HTMLElement) {
	el.addClass('heron-location-item');
	el.createDiv({ cls: 'heron-location-title', text: item.title });
	if (item.detail) el.createDiv({ cls: 'heron-location-detail', text: item.detail });
}

/** Fuzzy-filtered list of known locations: references, several definitions, or a file's symbols. */
export class LocationModal extends FuzzySuggestModal<LocationItem> {
	constructor(
		app: App,
		private items: LocationItem[],
		placeholder: string,
		private onChoose: (item: LocationItem) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.limit = 500;
	}

	getItems(): LocationItem[] { return this.items; }

	getItemText(item: LocationItem): string { return `${item.title} ${item.detail}`; }

	renderSuggestion(match: { item: LocationItem }, el: HTMLElement) {
		renderItem(match.item, el);
	}

	onChooseItem(item: LocationItem) { this.onChoose(item); }
}

/** Symbols across the project, asked from the language server as the query changes. */
export class WorkspaceSymbolModal extends SuggestModal<LocationItem> {
	constructor(
		app: App,
		private search: (query: string) => Promise<LocationItem[]>,
		private onChoose: (item: LocationItem) => void,
	) {
		super(app);
		this.setPlaceholder('Go to symbol in project…');
		this.emptyStateText = 'Type to search symbols';
		this.limit = 200;
	}

	getSuggestions(query: string): Promise<LocationItem[]> {
		return query.trim() ? this.search(query.trim()) : Promise.resolve([]);
	}

	renderSuggestion(item: LocationItem, el: HTMLElement) { renderItem(item, el); }

	onChooseSuggestion(item: LocationItem) { this.onChoose(item); }
}
