import { describe, it, expect, vi } from 'vitest';
import { MpLink } from './mp-link';

describe('MpLink (spec §7.5): a drop before the game is wired is not lost', () => {
	it('a loss after wiring calls onLost', () => {
		const link = new MpLink();
		const onLost = vi.fn();
		link.wire(onLost, vi.fn());
		link.lost();
		expect(onLost).toHaveBeenCalledTimes(1);
	});

	it('a loss before wiring is replayed when the game wires the link', () => {
		const link = new MpLink();
		link.lost();
		const onLost = vi.fn();
		const onFatal = vi.fn();
		link.wire(onLost, onFatal);
		expect(onLost).toHaveBeenCalledTimes(1);
		expect(onFatal).not.toHaveBeenCalled();
	});

	it('a fatal close before wiring is replayed as fatal, not as a loss', () => {
		const link = new MpLink();
		link.fatal();
		link.lost();
		const onLost = vi.fn();
		const onFatal = vi.fn();
		link.wire(onLost, onFatal);
		expect(onFatal).toHaveBeenCalledTimes(1);
		expect(onLost).not.toHaveBeenCalled();
	});

	it('messages before the route is set are buffered and flushed in order', () => {
		const link = new MpLink();
		link.deliver(1 as never);
		link.deliver(2 as never);
		const got: unknown[] = [];
		link.setRoute((m) => got.push(m));
		link.deliver(3 as never);
		expect(got).toEqual([1, 2, 3]);
	});
});
