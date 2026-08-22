/** In-memory stand-in for a GCS bucket, including ifGenerationMatch semantics. */

export type SaveOpts = {
	ifGenerationMatch?: string | number;
	metadata?: { contentType?: string; cacheControl?: string; metadata?: Record<string, string> };
};

export class PreconditionFailed extends Error {
	code = 412;
	constructor() {
		super('generation mismatch');
	}
}

type Entry = { contents: string; generation: number; metadata: Record<string, string> };

export class FakeFile {
	constructor(
		private bucket: FakeBucket,
		public name: string,
	) {}

	async save(contents: string, opts: SaveOpts = {}): Promise<void> {
		this.bucket.calls++;
		const existing = this.bucket.entries.get(this.name);
		if (opts.ifGenerationMatch !== undefined) {
			const want = String(opts.ifGenerationMatch);
			const have = existing ? String(existing.generation) : '0';
			if (want !== have) throw new PreconditionFailed();
		}
		this.bucket.entries.set(this.name, {
			contents,
			generation: this.bucket.nextGeneration++,
			metadata: opts.metadata?.metadata ?? {},
		});
	}

	async download(): Promise<[Buffer]> {
		this.bucket.calls++;
		if (this.bucket.failOnDownload) throw new Error('download should not have been called');
		const e = this.bucket.entries.get(this.name);
		if (!e) throw Object.assign(new Error('not found'), { code: 404 });
		return [Buffer.from(e.contents)];
	}

	async getMetadata(): Promise<[{ generation: string; size: number; metadata: Record<string, string> }]> {
		this.bucket.calls++;
		const e = this.bucket.entries.get(this.name);
		if (!e) throw Object.assign(new Error('not found'), { code: 404 });
		return [
			{
				generation: String(e.generation),
				size: Buffer.byteLength(e.contents),
				metadata: e.metadata,
			},
		];
	}

	async delete(opts: { ifGenerationMatch?: string | number } = {}): Promise<void> {
		this.bucket.calls++;
		const e = this.bucket.entries.get(this.name);
		if (!e) throw Object.assign(new Error('not found'), { code: 404 });
		if (opts.ifGenerationMatch !== undefined && String(opts.ifGenerationMatch) !== String(e.generation)) {
			throw new PreconditionFailed();
		}
		this.bucket.entries.delete(this.name);
	}

	async exists(): Promise<[boolean]> {
		this.bucket.calls++;
		return [this.bucket.entries.has(this.name)];
	}
}

export class FakeBucket {
	entries = new Map<string, Entry>();
	nextGeneration = 1;
	calls = 0;
	failOnDownload = false;

	file(name: string): FakeFile {
		return new FakeFile(this, name);
	}

	async getFiles(opts: { prefix?: string } = {}): Promise<[FakeFile[]]> {
		this.calls++;
		const names = [...this.entries.keys()].filter((n) =>
			opts.prefix ? n.startsWith(opts.prefix) : true,
		);
		return [names.map((n) => this.file(n))];
	}

	/** Test helper: write an object directly, bypassing validation. */
	putRaw(name: string, contents: string, metadata: Record<string, string>): void {
		this.entries.set(name, { contents, generation: this.nextGeneration++, metadata });
	}
}
