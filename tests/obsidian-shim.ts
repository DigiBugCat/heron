/**
 * Minimal stand-in for the `obsidian` runtime so UI components can be
 * exercised under jsdom. Only the APIs this plugin uses are implemented.
 */

type DomInfo = { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null> };

function applyInfo(el: HTMLElement, info?: DomInfo | string) {
	if (!info) return;
	if (typeof info === 'string') {
		el.className = info;
		return;
	}
	if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
	if (info.text !== undefined) el.textContent = info.text;
	for (const [k, v] of Object.entries(info.attr ?? {})) {
		if (v !== null) el.setAttribute(k, String(v));
	}
}

function installDomHelpers() {
	const proto = Node.prototype as unknown as Record<string, unknown>;
	if (proto.__heronShim) return;
	proto.__heronShim = true;

	proto.createEl = function (this: Node, tag: string, info?: DomInfo | string) {
		const el = (this.ownerDocument ?? document).createElement(tag);
		applyInfo(el, info);
		this.appendChild(el);
		return el;
	};
	proto.createDiv = function (this: Node, info?: DomInfo | string) {
		return (this as unknown as { createEl: (t: string, i?: unknown) => HTMLElement }).createEl('div', info);
	};
	proto.createSpan = function (this: Node, info?: DomInfo | string) {
		return (this as unknown as { createEl: (t: string, i?: unknown) => HTMLElement }).createEl('span', info);
	};
	proto.empty = function (this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	proto.appendText = function (this: Node, text: string) {
		this.appendChild((this.ownerDocument ?? document).createTextNode(text));
	};
	proto.setText = function (this: Node, text: string) {
		this.textContent = text;
	};
	Object.defineProperty(Node.prototype, 'doc', {
		get(this: Node) { return this.ownerDocument; },
		configurable: true,
	});

	const el = Element.prototype as unknown as Record<string, unknown>;
	el.addClass = function (this: Element, ...cls: string[]) { this.classList.add(...cls); };
	el.addClasses = function (this: Element, cls: string[]) { this.classList.add(...cls); };
	el.removeClass = function (this: Element, ...cls: string[]) { this.classList.remove(...cls); };
	el.removeClasses = function (this: Element, cls: string[]) { this.classList.remove(...cls); };
	el.toggleClass = function (this: Element, cls: string, value: boolean) { this.classList.toggle(cls, value); };
	el.hasClass = function (this: Element, cls: string) { return this.classList.contains(cls); };
	el.setAttr = function (this: Element, name: string, value: string | number | boolean | null) {
		if (value === null) this.removeAttribute(name);
		else this.setAttribute(name, String(value));
	};
	el.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
	};
	// Obsidian's hide/show set `display`; a class is enough for `isShown` below.
	el.hide = function (this: Element) { this.classList.add('shim-hidden'); };
	el.show = function (this: Element) { this.classList.remove('shim-hidden'); };
	el.toggle = function (this: Element, show: boolean) { this.classList.toggle('shim-hidden', !show); };
	// jsdom has no layout; treat elements as shown unless an ancestor is hidden.
	el.isShown = function (this: Element) {
		return this.isConnected && !this.closest('.shim-hidden');
	};

	// jsdom does not implement scrolling or layout.
	el.scrollIntoView ??= function () { /* no layout in jsdom */ };

	// CodeMirror measures text with ranges, which jsdom does not implement.
	const range = Range.prototype as unknown as Record<string, unknown>;
	range.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () { /* empty */ } });
	range.getBoundingClientRect ??= () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
}

installDomHelpers();

export function setIcon(el: HTMLElement, icon: string) {
	(el as unknown as { empty: () => void }).empty();
	el.dataset.icon = icon;
	el.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
}

export interface Debouncer<T extends unknown[]> {
	(...args: T): Debouncer<T>;
	cancel(): Debouncer<T>;
	run(): void;
}

export function debounce<T extends unknown[]>(cb: (...args: T) => unknown, timeout = 0): Debouncer<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastArgs: T | null = null;
	const fn = ((...args: T) => {
		lastArgs = args;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => { timer = null; cb(...args); }, timeout);
		return fn;
	}) as Debouncer<T>;
	fn.cancel = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		return fn;
	};
	fn.run = () => {
		if (timer && lastArgs) {
			fn.cancel();
			cb(...lastArgs);
		}
	};
	return fn;
}

export class Component {
	private _loaded = false;
	private _children: Component[] = [];
	private _cleanups: (() => void)[] = [];

	load() {
		if (this._loaded) return;
		this._loaded = true;
		this.onload();
		for (const child of [...this._children]) child.load();
	}

	onload() { /* override */ }

	unload() {
		if (!this._loaded) return;
		this._loaded = false;
		for (const child of this._children.splice(0)) child.unload();
		for (const cleanup of this._cleanups.splice(0)) cleanup();
		this.onunload();
	}

	onunload() { /* override */ }

	addChild<T extends Component>(child: T): T {
		this._children.push(child);
		if (this._loaded) child.load();
		return child;
	}

	removeChild<T extends Component>(child: T): T {
		const i = this._children.indexOf(child);
		if (i >= 0) {
			this._children.splice(i, 1);
			child.unload();
		}
		return child;
	}

	register(cb: () => unknown) {
		this._cleanups.push(() => { cb(); });
	}

	registerDomEvent(el: EventTarget, type: string, cb: EventListener, options?: AddEventListenerOptions) {
		el.addEventListener(type, cb, options);
		this.register(() => el.removeEventListener(type, cb, options));
	}

	registerInterval(id: number) {
		this.register(() => clearInterval(id));
		return id;
	}

	registerEvent() { /* not needed in tests */ }
}

export const Platform = { isMacOS: false, isDesktopApp: true, isMobile: false };

/** Mod-click opens a new tab, as in Obsidian. */
export const Keymap = {
	isModEvent(evt?: MouseEvent | KeyboardEvent | null): false | 'tab' {
		return evt?.ctrlKey || evt?.metaKey ? 'tab' : false;
	},
};

/** Records messages; a DocumentFragment message is recorded by its text. `Notice.shown` lists the live ones. */
export class Notice {
	static messages: string[] = [];
	static shown: Notice[] = [];
	noticeEl: HTMLElement;
	constructor(message: string | DocumentFragment, public duration?: number) {
		this.noticeEl = document.createElement('div');
		if (typeof message === 'string') this.noticeEl.textContent = message;
		else this.noticeEl.append(message);
		Notice.messages.push(this.noticeEl.textContent ?? '');
		Notice.shown.push(this);
	}
	setMessage(message: string) { this.noticeEl.textContent = message; return this; }
	hide() { Notice.shown = Notice.shown.filter((n) => n !== this); }
}

export class TAbstractFile {
	constructor(public path = '') {}
	get name(): string { return this.path.slice(this.path.lastIndexOf('/') + 1); }
}

export class TFile extends TAbstractFile {
	stat = { size: 0, ctime: 0, mtime: 0 };
	get extension(): string {
		const dot = this.name.lastIndexOf('.');
		return dot < 0 ? '' : this.name.slice(dot + 1);
	}
	get basename(): string {
		const dot = this.name.lastIndexOf('.');
		return dot < 0 ? this.name : this.name.slice(0, dot);
	}
}

export class TFolder extends TAbstractFile {
	isRoot() { return this.path === '/'; }
}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

/** Tests never reach the network. */
export function requestUrl(): Promise<never> {
	return Promise.reject(new Error('requestUrl is not available in tests'));
}

// Obsidian's globals for the focused window's document.
(window as unknown as Record<string, unknown>).activeDocument ??= document;

class ShimComponent<T extends HTMLElement> {
	constructor(readonly el: T) {}
}

export class TextComponent extends ShimComponent<HTMLInputElement> {
	inputEl = this.el;
	private listener: ((value: string) => unknown) | null = null;
	constructor(parent: HTMLElement) {
		super(parent.createEl('input'));
		this.inputEl.addEventListener('input', () => this.listener?.(this.inputEl.value));
	}
	setPlaceholder(text: string) { this.inputEl.placeholder = text; return this; }
	setValue(value: string) { this.inputEl.value = value; return this; }
	getValue() { return this.inputEl.value; }
	setDisabled(disabled: boolean) { this.inputEl.disabled = disabled; return this; }
	onChange(cb: (value: string) => unknown) { this.listener = cb; return this; }
}

export class ButtonComponent extends ShimComponent<HTMLButtonElement> {
	buttonEl = this.el;
	constructor(parent: HTMLElement) { super(parent.createEl('button')); }
	setButtonText(text: string) { this.buttonEl.textContent = text; return this; }
	setCta() { this.buttonEl.addClass('mod-cta'); return this; }
	setWarning() { this.buttonEl.addClass('mod-warning'); return this; }
	onClick(cb: (evt: MouseEvent) => unknown) { this.buttonEl.addEventListener('click', (evt) => cb(evt)); return this; }
}

/** A settings row with the components tests use. */
export class Setting {
	settingEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
		this.nameEl = this.settingEl.createDiv({ cls: 'setting-item-name' });
		this.descEl = this.settingEl.createDiv({ cls: 'setting-item-description' });
		this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
	}
	setName(name: string) {
		this.nameEl.textContent = name;
		this.settingEl.dataset.name = name;
		return this;
	}
	setDesc(desc: string) { this.descEl.textContent = desc; return this; }
	setHeading() { this.settingEl.addClass('setting-item-heading'); return this; }
	addText(cb: (text: TextComponent) => unknown) { cb(new TextComponent(this.controlEl)); return this; }
	addButton(cb: (button: ButtonComponent) => unknown) { cb(new ButtonComponent(this.controlEl)); return this; }
}

export class MenuItem {
	title = '';
	icon = '';
	callback: () => unknown = () => undefined;
	checked: boolean | null = null;
	disabled = false;
	/** Rendered title text; `fragment` keeps the structure of a DocumentFragment title. */
	fragment: DocumentFragment | null = null;
	setTitle(title: string | DocumentFragment) {
		if (typeof title === 'string') {
			this.title = title;
		} else {
			this.fragment = title;
			this.title = Array.from(title.childNodes).map((n) => n.textContent).join('\n');
		}
		return this;
	}
	setChecked(checked: boolean | null) { this.checked = checked; return this; }
	setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
	setIcon(icon: string) { this.icon = icon; return this; }
	onClick(cb: () => unknown) { this.callback = cb; return this; }
}

/** Records items instead of rendering; `Menu.last` is the most recently shown menu. */
export class Menu {
	static last: Menu | null = null;
	/** Items in order, with `null` for separators. */
	items: (MenuItem | null)[] = [];
	addItem(cb: (item: MenuItem) => unknown) {
		const item = new MenuItem();
		cb(item);
		this.items.push(item);
		return this;
	}
	addSeparator() { this.items.push(null); return this; }
	showAtMouseEvent() { Menu.last = this; return this; }
	showAtPosition() { Menu.last = this; return this; }
}

/** Records registered keys; `trigger` runs a handler as a key press would. */
export class Scope {
	keys: { modifiers: string[]; key: string; handler: (evt: KeyboardEvent) => unknown }[] = [];
	constructor(public parent?: Scope) {}
	register(modifiers: string[], key: string, handler: (evt: KeyboardEvent) => unknown) {
		const entry = { modifiers, key, handler };
		this.keys.push(entry);
		return entry;
	}
	unregister(handler: unknown) {
		this.keys = this.keys.filter((k) => k !== handler);
	}
	trigger(modifiers: string[], key: string): unknown {
		const entry = this.keys.find((k) => k.key === key && k.modifiers.join() === modifiers.join());
		return entry?.handler(new KeyboardEvent('keydown', { key }));
	}
}

/**
 * An `ItemView` without a workspace: tests pass a leaf with an `app`, then
 * call `load()` and `onOpen()`. `actions` records header buttons.
 */
export class ItemView extends Component {
	app: unknown;
	containerEl: HTMLElement = document.createElement('div');
	contentEl: HTMLElement;
	navigation = false;
	scope: Scope | null = null;
	actions: { icon: string; title: string; el: HTMLElement }[] = [];
	constructor(public leaf: { app?: unknown }) {
		super();
		this.app = leaf.app;
		this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
	}
	addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
		const el = document.createElement('a');
		el.setAttribute('aria-label', title);
		el.addEventListener('click', (evt) => callback(evt));
		this.actions.push({ icon, title, el });
		return el;
	}
	getState(): Record<string, unknown> { return {}; }
	setState(_state: unknown, _result: unknown): Promise<void> { return Promise.resolve(); }
	getEphemeralState(): Record<string, unknown> { return {}; }
	setEphemeralState(_state: unknown) { /* override */ }
	onOpen(): Promise<void> { return Promise.resolve(); }
	onClose(): Promise<void> { return Promise.resolve(); }
}

/**
 * A `FileView` without a workspace: tests set `file` and call
 * `onLoadFile` themselves, as Obsidian does when a tab opens a file.
 */
export class FileView extends ItemView {
	file: TFile | null = null;
	allowNoFile = false;
	navigation = true;
	getDisplayText() { return this.file?.basename ?? ''; }
	canAcceptExtension(_extension: string) { return false; }
	onLoadFile(_file: TFile): Promise<void> { return Promise.resolve(); }
	onUnloadFile(_file: TFile): Promise<void> { return Promise.resolve(); }
}

export class FileSystemAdapter {
	constructor(private basePath = '') {}
	getBasePath() { return this.basePath; }
}

/** Obsidian's event emitter, for settings change notifications. */
export class Events {
	private handlers = new Map<string, Set<(...args: unknown[]) => unknown>>();
	on(name: string, callback: (...args: unknown[]) => unknown) {
		let set = this.handlers.get(name);
		if (!set) this.handlers.set(name, (set = new Set()));
		set.add(callback);
		return { name, callback };
	}
	offref(ref: { name: string; callback: (...args: unknown[]) => unknown }) {
		this.handlers.get(ref.name)?.delete(ref.callback);
	}
	trigger(name: string, ...args: unknown[]) {
		for (const callback of this.handlers.get(name) ?? []) callback(...args);
	}
}

export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) { super(); }
}

/**
 * Records opened modals instead of showing them; `Modal.opened` lists them
 * in order, and closed ones in `Modal.closed`. Tests call `onOpen()` themselves to render one.
 */
export class Modal {
	static opened: Modal[] = [];
	static closed: Modal[] = [];
	modalEl: HTMLElement = document.createElement('div');
	titleEl: HTMLElement = this.modalEl.createDiv({ cls: 'modal-title' });
	contentEl: HTMLElement = this.modalEl.createDiv({ cls: 'modal-content' });
	/** Typed loosely so tests can cast recorded modals to the real classes. */
	scope: unknown = new Scope();
	constructor(public app: unknown) {}
	open() { Modal.opened.push(this); }
	close() { Modal.closed.push(this); this.onClose(); }
	onOpen(): void | Promise<void> { /* override */ }
	onClose() { /* override */ }
}

/** A file view with unsaved state; `saves` counts calls to `save`. */
export class TextFileView extends Component {
	file: TFile | null = null;
	saves = 0;
	save(): Promise<void> { this.saves++; return Promise.resolve(); }
}

/** Like Obsidian's: the input sits in `.prompt-input-container`, results below it. */
export abstract class SuggestModal<T> extends Modal {
	limit = 100;
	emptyStateText = '';
	placeholder = '';
	instructions: { command: string; purpose: string }[] = [];
	inputEl: HTMLInputElement;
	resultContainerEl: HTMLElement;
	constructor(app: unknown) {
		super(app);
		const container = this.modalEl.createDiv({ cls: 'prompt-input-container' });
		this.inputEl = container.createEl('input', { cls: 'prompt-input' });
		this.resultContainerEl = this.modalEl.createDiv({ cls: 'prompt-results' });
	}
	setPlaceholder(placeholder: string) { this.placeholder = placeholder; }
	setInstructions(instructions: { command: string; purpose: string }[]) { this.instructions = instructions; }
	selectActiveSuggestion(_evt: MouseEvent | KeyboardEvent) { /* no selection in tests */ }
	abstract getSuggestions(query: string): T[] | Promise<T[]>;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<T> {
	abstract getItems(): T[];
	getSuggestions(): T[] { return this.getItems(); }
}


/** Puts the markdown source in the element as plain text; `MarkdownRenderer.rendered` records calls. */
export class MarkdownRenderer {
	static rendered: string[] = [];
	static render(_app: unknown, markdown: string, el: HTMLElement, _sourcePath?: string, _component?: Component): Promise<void> {
		MarkdownRenderer.rendered.push(markdown);
		el.createDiv({ cls: 'markdown-shim', text: markdown });
		return Promise.resolve();
	}
}
