/**
 * Process guards for an unattended `--brain v2` run (companionV2).
 *
 * - An unhandled rejection is logged as an `unhandled-rejection` event, and the bot keeps running.
 * - An uncaught exception is logged as an `uncaught-exception` event. The brain file is flushed, then the process
 *   exits 1.
 * - After a stop signal, `armHardExit` starts an unref'd timer. It exits 0 if something keeps the event loop alive
 *   past the clean stop.
 */
export interface CrashGuardDeps {
	/** Writes one event line to the brain log. */
	event: (kind: string, data: unknown) => void;
	/** Writes the brain file now, synchronously. */
	flush: () => void;
	print: (line: string) => void;
	/** Tests may replace it; the default is process.exit. */
	exit?: (code: number) => void;
}

/** A hard-exit fallback after a stop signal: long enough for a clean stop (flush, revert, close). */
export const HARD_EXIT_MS = 5000;

const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/** Installs both listeners and returns their removal (called on a normal stop). */
export function installCrashGuards(d: CrashGuardDeps): () => void {
	const exit = d.exit ?? ((code: number) => process.exit(code));
	const onRejection = (reason: unknown): void => {
		try {
			d.event('unhandled-rejection', { error: describe(reason) });
			d.print(`unhandled rejection (still running): ${reason instanceof Error ? reason.message : String(reason)}`);
		} catch {
			// The guard itself must never throw.
		}
	};
	const onException = (err: unknown): void => {
		try {
			d.event('uncaught-exception', { error: describe(err) });
		} catch {
			// Keep going: the flush matters more than the log line.
		}
		try {
			d.flush();
		} catch {
			// Nothing more to do.
		}
		try {
			d.print(`uncaught exception, exiting: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			exit(1);
		}
	};
	process.on('unhandledRejection', onRejection);
	process.on('uncaughtException', onException);
	return () => {
		process.off('unhandledRejection', onRejection);
		process.off('uncaughtException', onException);
	};
}

/** Exits 0 after `ms` unless the process ends first. The timer is unref'd, so it never keeps the process alive. */
export function armHardExit(ms = HARD_EXIT_MS, exit: (code: number) => void = (code) => process.exit(code)): ReturnType<typeof setTimeout> {
	const t = setTimeout(() => exit(0), ms);
	t.unref();
	return t;
}
