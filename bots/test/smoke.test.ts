import { describe, expect, it } from 'vitest';
import { BotClient, CLIENT_VERSION, WALK_SPEED } from 'minicraft-bot';

describe('minicraft-bot SDK smoke test', () => {
	it('resolves the SDK build and its constants', () => {
		expect(WALK_SPEED).toBe(5);
		expect(typeof CLIENT_VERSION).toBe('number');
		expect(typeof BotClient).toBe('function');
	});
});
