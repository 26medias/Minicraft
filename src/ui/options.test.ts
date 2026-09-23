import { describe, it, expect } from 'vitest';
import { bindingLabel } from './options';

describe('bindingLabel', () => {
	it('shows the unbound value \'\' as a dash, and a code as itself (catches an empty, unclickable-looking button)', () => {
		expect(bindingLabel('')).toBe('—');
		expect(bindingLabel('KeyP')).toBe('KeyP');
	});
});
