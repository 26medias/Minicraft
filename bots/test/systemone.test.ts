import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Choice } from '../src/brain/brain.js';
import { buildRequest, mapResponse, SystemOneBrain } from '../src/brain/systemone.js';
import fixture from './fixtures/laya-exchange.json';

/**
 * Task 6: the Laya/CLM `/v1/systemone` adapter (spec §5, §12a), replayed against
 * `test/fixtures/laya-exchange.json` — a REAL recorded exchange (never `laya/tests/test_serve.py`'s
 * fake router). Against a `node:http` fake on port 0, never the real Laya.
 */

const FIXTURE_CHOICE: Choice = {
	type: 'choice',
	instructions: fixture.request.questions.next.instructions,
	options: fixture.request.questions.next.criteria,
};
const OFFERED = Object.keys(FIXTURE_CHOICE.options);

let server: Server | null = null;

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = null;
	}
});

interface Captured {
	method: string | undefined;
	url: string | undefined;
	body: string;
}

/** Starts a fake systemone server on port 0; `respond` decides each request's response. */
function startServer(respond: (req: IncomingMessage, res: ServerResponse, captured: Captured) => void): Promise<{ url: string; requests: Captured[] }> {
	const requests: Captured[] = [];
	return new Promise((resolve, reject) => {
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				const captured: Captured = { method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') };
				requests.push(captured);
				respond(req, res, captured);
			});
		});
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server!.address();
			if (!addr || typeof addr === 'string') return reject(new Error('no port'));
			resolve({ url: `http://127.0.0.1:${addr.port}`, requests });
		});
	});
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(text);
}

describe('buildRequest (pure)', () => {
	it('renames Choice.options to criteria verbatim; deep-equal to the recorded request after JSON.parse', () => {
		const built = buildRequest(fixture.request.state, FIXTURE_CHOICE);
		expect(JSON.parse(JSON.stringify(built))).toEqual(fixture.request);
	});
});

describe('mapResponse (pure)', () => {
	it('maps answers.next only: best is the choice, probs restricted to the offered options, confidence = max(p)', () => {
		const answer = mapResponse(fixture.response, OFFERED);
		expect(answer.type).toBe('choice');
		expect(answer.best).toBe('help_build');
		expect(answer.probs.follow).toBeCloseTo(0.2367, 4);
		expect(answer.probs.watch).toBeCloseTo(0.2469, 4);
		expect(answer.probs.help_build).toBeCloseTo(0.4168, 4);
		expect(answer.probs.idle).toBeCloseTo(0.0996, 4);
		// max(p): equal to answer_confidence here, but computed from probs, never read off either
		// confidence field.
		expect(answer.confidence).toBeCloseTo(0.4168, 4);
		// NOT Laya's own calibrated (entropy-based) confidence field.
		expect(answer.confidence).not.toBeCloseTo(0.076, 2);
	});

	it('a missing offered option counts as 0, and probs are renormalised over the offered options only', () => {
		const resp = {
			answers: {
				next: {
					choice: 'watch',
					// idle is missing; stop is offered by nobody and must be ignored.
					probabilities: { follow: 0.3, watch: 0.5, stop: 0.9 },
					confidence: 0.5,
					answer_confidence: 0.5,
				},
			},
		};
		const answer = mapResponse(resp, ['follow', 'watch', 'help_build', 'idle']);
		expect(answer.probs.idle).toBe(0);
		expect(answer.probs.stop).toBeUndefined();
		const sum = answer.probs.follow + answer.probs.watch + answer.probs.help_build + answer.probs.idle;
		expect(sum).toBeCloseTo(1, 10);
		expect(answer.probs.watch).toBeCloseTo(0.5 / 0.8, 10);
		expect(answer.confidence).toBeCloseTo(0.5 / 0.8, 10);
	});

	it('throws on a malformed response (answers.next missing)', () => {
		expect(() => mapResponse({ answers: {} }, OFFERED)).toThrow();
	});
});

describe('SystemOneBrain.ask against a node:http fake (port 0)', () => {
	it('sends the fixture request over the wire and maps the fixture response to Answer', async () => {
		const { url, requests } = await startServer((_req, res) => jsonResponse(res, 200, fixture.response));
		const brain = new SystemOneBrain({ name: 'laya', url, healthPath: '/health' });
		const answer = await brain.ask(fixture.request.state, FIXTURE_CHOICE, new AbortController().signal);

		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe('POST');
		expect(requests[0].url).toBe('/v1/systemone');
		expect(JSON.parse(requests[0].body)).toEqual(fixture.request);

		expect(answer.best).toBe('help_build');
		expect(answer.confidence).toBeCloseTo(0.4168, 4);
	});

	it('health() GETs the configured health path', async () => {
		const { url, requests } = await startServer((_req, res) => jsonResponse(res, 200, { status: 'ok' }));
		const brain = new SystemOneBrain({ name: 'laya', url, healthPath: '/health' });
		expect(await brain.health()).toBe(true);
		expect(requests[0]).toMatchObject({ method: 'GET', url: '/health' });
	});

	it('health() is false on a non-2xx response or a connection failure', async () => {
		const { url } = await startServer((_req, res) => jsonResponse(res, 500, { status: 'down' }));
		const brain = new SystemOneBrain({ name: 'laya', url, healthPath: '/health' });
		expect(await brain.health()).toBe(false);

		const deadBrain = new SystemOneBrain({ name: 'laya', url: 'http://127.0.0.1:1', healthPath: '/health' });
		expect(await deadBrain.health()).toBe(false);
	});

	it('a timeout (an aborted signal) rejects ask() instead of hanging', async () => {
		const { url } = await startServer((_req, res) => {
			// Never responds within the test's lifetime: the client's own abort is what ends this.
			setTimeout(() => jsonResponse(res, 200, fixture.response), 60_000);
		});
		const brain = new SystemOneBrain({ name: 'laya', url, healthPath: '/health' });
		const ac = new AbortController();
		const asked = brain.ask(fixture.request.state, FIXTURE_CHOICE, ac.signal);
		setTimeout(() => ac.abort(), 20);
		await expect(asked).rejects.toThrow();
	});

	it('a non-ok HTTP response rejects with the status', async () => {
		const { url } = await startServer((_req, res) => jsonResponse(res, 422, { detail: "choice question needs a non-empty 'criteria' object" }));
		const brain = new SystemOneBrain({ name: 'laya', url, healthPath: '/health' });
		await expect(brain.ask(fixture.request.state, FIXTURE_CHOICE, new AbortController().signal)).rejects.toThrow(/422/);
	});
});
