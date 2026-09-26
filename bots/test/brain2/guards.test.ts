import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The overnight run's process guards (companionV2): an unhandled rejection is logged and the bot keeps running;
 * an uncaught exception is logged, the brain file flushed, and the process exits non-zero; after a stop signal a
 * 5 s unref'd timer exits even if something keeps the event loop alive. Run in a real child process.
 */
const BOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const child = (mode: string) => {
	const t = Date.now();
	const r = spawnSync(process.execPath, ['--import', 'tsx', 'test/fixtures/guards-child.ts', mode], { cwd: BOTS, encoding: 'utf8', timeout: 15_000 });
	return { status: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t };
};

describe('brain2 process guards', () => {
	// Red if there is no rejection listener (Node 22 exits 1 on the rejection) or if the event isn't logged, or if
	// removing the guards leaves a listener behind.
	it('an unhandled rejection is logged as an event and the process keeps running; removal clears both listeners', () => {
		const r = child('rejection');
		expect(r.out).toContain('"event":"unhandled-rejection"');
		expect(r.out).toContain('boom');
		expect(r.out).toContain('ALIVE');
		expect(r.out).toContain('LISTENERS 0 0');
		expect(r.status).toBe(0);
	}, 20_000);

	// Red if the exception isn't logged, the brain file isn't flushed, or the process goes on (or exits 0).
	it('an uncaught exception is logged, flushes the brain file, and exits non-zero', () => {
		const r = child('exception');
		expect(r.out).toContain('"event":"uncaught-exception"');
		expect(r.out).toContain('bang');
		expect(r.out.indexOf('FLUSH')).toBeGreaterThan(r.out.indexOf('uncaught-exception'));
		expect(r.out).not.toContain('NOT-REACHED');
		expect(r.status).toBe(1);
	}, 20_000);

	// Red if the fallback never fires (the interval keeps the process up until the spawn timeout).
	it('the hard exit fires with 0 when something keeps the event loop alive', () => {
		const r = child('hard-exit');
		expect(r.status).toBe(0);
		expect(r.ms).toBeLessThan(10_000);
	}, 20_000);

	// Red if the timer isn't unref'd: the process would wait the whole 5 s for it.
	it('the hard exit does not itself keep the process alive', () => {
		const t = child('hard-exit-unref');
		const base = child('none');
		expect(t.status).toBe(0);
		expect(t.ms - base.ms).toBeLessThan(2500);
	}, 30_000);
});
