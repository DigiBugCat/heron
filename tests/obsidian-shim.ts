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
	if (proto.__soShim) return;
	proto.__soShim = true;

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
	el.hide = function (this: Element) { this.classList.add('so-hidden'); };
	el.show = function (this: Element) { this.classList.remove('so-hidden'); };
	el.toggle = function (this: Element, show: boolean) { this.classList.toggle('so-hidden', !show); };
	// jsdom has no layout; treat elements as shown unless an ancestor is hidden by class.
	el.isShown = function (this: Element) {
		return this.isConnected && !this.closest('.so-hidden, .so-section-collapsed');
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

export class TAbstractFile { path = ''; }
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

/** Tests never reach the network. */
export function requestUrl(): Promise<never> {
	return Promise.reject(new Error('requestUrl is not available in tests'));
}

// Obsidian's globals for the focused window's document.
(window as unknown as Record<string, unknown>).activeDocument ??= document;

/** Renders markdown as plain text, which is enough to check what was rendered. */
export const MarkdownRenderer = {
	render(_app: unknown, markdown: string, el: HTMLElement) {
		el.createDiv({ cls: 'markdown-shim', text: markdown });
		return Promise.resolve();
	},
};

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
	setName(name: string) { this.nameEl.textContent = name; return this; }
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

export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) { super(); }
}

/** Records opened modals instead of showing them; `Modal.opened` lists them in order. */
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
	constructor(public app: unknown) {}
	open() { Modal.opened.push(this); }
	close() { Modal.closed.push(this); }
}

export abstract class SuggestModal<T> extends Modal {
	limit = 100;
	emptyStateText = '';
	placeholder = '';
	setPlaceholder(placeholder: string) { this.placeholder = placeholder; }
	abstract getSuggestions(query: string): T[] | Promise<T[]>;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<T> {
	abstract getItems(): T[];
	getSuggestions(): T[] { return this.getItems(); }
}
