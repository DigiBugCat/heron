/** Most locations kept in each direction. */
const MAX_ENTRIES = 100;

/**
 * Back and forward stacks for code navigation, like a browser's: jumping
 * records where you were and clears the forward stack.
 */
export class NavHistory<T> {
	private backStack: T[] = [];
	private forwardStack: T[] = [];

	constructor(private same: (a: T, b: T) => boolean) {}

	/** Records `from` before jumping away from it. */
	record(from: T) {
		const last = this.backStack[this.backStack.length - 1];
		if (!last || !this.same(last, from)) {
			this.backStack.push(from);
			if (this.backStack.length > MAX_ENTRIES) this.backStack.shift();
		}
		this.forwardStack = [];
	}

	/** The location to go back to from `current`, or null. */
	back(current: T): T | null {
		const target = this.backStack.pop();
		if (target === undefined) return null;
		this.forwardStack.push(current);
		return target;
	}

	/** The location to go forward to from `current`, or null. */
	forward(current: T): T | null {
		const target = this.forwardStack.pop();
		if (target === undefined) return null;
		this.backStack.push(current);
		return target;
	}

	canGoBack(): boolean { return this.backStack.length > 0; }

	canGoForward(): boolean { return this.forwardStack.length > 0; }

	clear() {
		this.backStack = [];
		this.forwardStack = [];
	}
}
