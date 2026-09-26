/**
 * A child process for guards.test.ts: installs the brain2 crash guards (or arms the hard exit) and misbehaves as
 * `process.argv[2]` says. Real process semantics: Node 22 crashes on an unhandled rejection with no listener.
 */
import { armHardExit, installCrashGuards } from '../../src/brain2/guards.js';

const out = (s: string) => process.stdout.write(`${s}\n`);
const mode = process.argv[2];
const guards = () => installCrashGuards({
	event: (kind, data) => out(JSON.stringify({ event: kind, data })),
	flush: () => out('FLUSH'),
	print: () => undefined,
});

if (mode === 'rejection') {
	const remove = guards();
	void Promise.reject(new Error('boom'));
	setTimeout(() => {
		out('ALIVE');
		remove();
		out(`LISTENERS ${process.listenerCount('unhandledRejection')} ${process.listenerCount('uncaughtException')}`);
	}, 200);
} else if (mode === 'exception') {
	guards();
	setTimeout(() => {
		throw new Error('bang');
	}, 10);
	setTimeout(() => out('NOT-REACHED'), 500);
} else if (mode === 'hard-exit') {
	setInterval(() => undefined, 1000);           // something keeps the event loop alive
	armHardExit(300);
} else if (mode === 'hard-exit-unref') {
	armHardExit(5000);                             // must not itself keep the process alive
}
