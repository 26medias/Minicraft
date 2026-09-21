/**
 * A stored record that cannot be fully parsed at its own declared shape. A
 * world that throws this is never opened and never autosaved (spec §4).
 */
export class SaveCorrupt extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = 'SaveCorrupt';
	}
}

/** Two copies of one world that disagree on height or generator version. */
export class SaveMismatch extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = 'SaveMismatch';
	}
}
