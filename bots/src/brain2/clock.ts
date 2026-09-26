/** A monotonic ms clock. Brain2 never reads Date.now() directly: the TUI, replay and tests all drive this. */
export type Clock = () => number;

export class ManualClock {
	constructor(public t = 0) {}
	now: Clock = () => this.t;
	advance(ms: number): void {
		this.t += ms;
	}
}
