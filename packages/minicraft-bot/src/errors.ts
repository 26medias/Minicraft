/** The SDK's typed errors (spec §6, §12a). */
import type { Pose } from './bot-world';

/** The server's minimum client version is above this SDK's `CLIENT_VERSION` (close 4004, `outdated`). */
export class OutdatedClientError extends Error {
	override readonly name = 'OutdatedClientError';
	constructor(
		/** This SDK's `CLIENT_VERSION`. */
		readonly ver: number,
		/** The server's minimum. */
		readonly min: number,
	) {
		super(`the server needs client version ${min}, this SDK is version ${ver}: rebuild the SDK (npm run build:bot in the Minicraft repo)`);
	}
}

/** Another connection with the same name and bid took over (close 4001). */
export class ReplacedError extends Error {
	override readonly name = 'ReplacedError';
	constructor() {
		super('replaced: another connection with the same name and bid joined (close 4001)');
	}
}

/** The server refused the connection or ended it for good. `code` is the close code (e.g. 4006 unknown world). */
export class ServerRefusedError extends Error {
	override readonly name = 'ServerRefusedError';
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

/** An action was called before `connect()` resolved, or after `close()`. A programming error. */
export class NotConnectedError extends Error {
	override readonly name = 'NotConnectedError';
	constructor(action: string) {
		super(`${action}: the bot is not connected (await connect() first; after close() it stays closed)`);
	}
}

/**
 * `walkTo` stopped: `wall` (the ground ahead rises more than 1 block, or the body can't enter the next
 * column) or `noGround` (no standable cell within 64 blocks below). `at` is where the bot stopped.
 */
export class BlockedError extends Error {
	override readonly name = 'BlockedError';
	constructor(
		readonly at: Pose,
		readonly reason: 'wall' | 'noGround',
	) {
		super(`walkTo blocked (${reason}) at ${at.x.toFixed(2)}, ${at.y.toFixed(2)}, ${at.z.toFixed(2)}`);
	}
}
