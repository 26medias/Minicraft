import { describe, it, expect } from 'vitest';
import { nextToasts, type ToastKind } from './toasts';

const t = (kind: ToastKind, id: string) => ({ kind, id });

describe('nextToasts: the toast cap (spec §8)', () => {
	it('a cheat toast never evicts a multiplayer toast (catches a global cap pushing out "Noah has to go")', () => {
		const mp1 = t('mp', 'a'), mp2 = t('mp', 'b'), cheat = t('cheat', 'c');
		const r = nextToasts([mp1, mp2], cheat);
		expect(r.keep).toEqual([mp1, mp2, cheat]);
		expect(r.drop).toEqual([]);
	});
	it('a new cheat toast replaces the visible one (catches stacking cheat toasts on Enter mashing)', () => {
		const old = t('cheat', 'x'), mp = t('mp', 'm'), neu = t('cheat', 'y');
		const r = nextToasts([old, mp], neu);
		expect(r.keep).toEqual([mp, neu]);
		expect(r.drop).toEqual([old]);
	});
	it('multiplayer toasts are uncapped, as today (catches a cap applied to them)', () => {
		const a = t('mp', '1'), b = t('mp', '2'), c = t('mp', '3');
		expect(nextToasts([a, b], c)).toEqual({ keep: [a, b, c], drop: [] });
	});
});
