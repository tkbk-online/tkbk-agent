export interface Embedder {
	/** identifies the model so an index built with another one is rebuilt */
	readonly id: string
	embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}

export interface GatewayEmbedderOptions {
	/** OpenAI-compatible base, e.g. https://api.tkbk.online/v1 */
	baseUrl: string
	apiKey: string
	model: string
	fetchImpl?: typeof fetch
	/** texts per request */
	batchSize?: number
	timeoutMs?: number
	/** called with the gateway's reported token usage per request */
	onUsage?: (usage: { promptTokens: number; totalTokens: number }) => void
}

const DEFAULT_BATCH = 64
const DEFAULT_TIMEOUT_MS = 60_000
/** Longest text sent for one embedding; longer chunks are cut (code rarely needs more). */
const MAX_INPUT_CHARS = 6_000

export class EmbeddingUnavailableError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message)
		this.name = "EmbeddingUnavailableError"
	}
}

/**
 * Embeddings through the TKBK gateway (`POST {baseUrl}/embeddings`, OpenAI
 * list shape). Any 4xx that is not a rate limit means the gateway does not
 * serve this model or the key cannot use it: the index then falls back to
 * lexical search instead of failing the whole build.
 */
export class GatewayEmbedder implements Embedder {
	readonly id: string
	private readonly fetchImpl: typeof fetch
	private readonly batchSize: number
	private readonly timeoutMs: number

	constructor(private readonly options: GatewayEmbedderOptions) {
		this.id = `gateway:${options.model}`
		this.fetchImpl = options.fetchImpl ?? fetch
		this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH)
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
		const out: Float32Array[] = []
		for (let i = 0; i < texts.length; i += this.batchSize) {
			const batch = texts
				.slice(i, i + this.batchSize)
				.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t))
			out.push(...(await this.embedBatch(batch, signal)))
		}
		return out
	}

	private async embedBatch(batch: string[], signal?: AbortSignal): Promise<Float32Array[]> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		const onAbort = () => controller.abort()
		signal?.addEventListener("abort", onAbort, { once: true })
		try {
			const url = `${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`
			let response: Response
			try {
				response = await this.fetchImpl(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.options.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ model: this.options.model, input: batch, encoding_format: "float" }),
					signal: controller.signal,
				})
			} catch (error) {
				throw new EmbeddingUnavailableError(
					`embeddings request failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			if (!response.ok) {
				const body = (await response.text().catch(() => "")).slice(0, 300)
				throw new EmbeddingUnavailableError(`embeddings HTTP ${response.status}: ${body}`, response.status)
			}
			const payload = (await response.json()) as {
				data?: Array<{ index?: number; embedding?: number[] }>
				usage?: { prompt_tokens?: number; total_tokens?: number }
			}
			if (payload?.usage && this.options.onUsage) {
				this.options.onUsage({
					promptTokens: payload.usage.prompt_tokens ?? 0,
					totalTokens: payload.usage.total_tokens ?? 0,
				})
			}
			const rows = payload?.data ?? []
			if (rows.length !== batch.length) {
				throw new EmbeddingUnavailableError(`embeddings returned ${rows.length} vectors for ${batch.length} inputs`)
			}
			const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
			return ordered.map((row) => {
				if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
					throw new EmbeddingUnavailableError("embeddings response has an empty vector")
				}
				return normalize(Float32Array.from(row.embedding))
			})
		} finally {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
		}
	}
}

/** Unit-length copy so cosine similarity is a dot product. */
export function normalize(vector: Float32Array): Float32Array {
	let sum = 0
	for (let i = 0; i < vector.length; i++) {
		sum += vector[i] * vector[i]
	}
	const norm = Math.sqrt(sum)
	if (norm === 0) {
		return vector
	}
	const out = new Float32Array(vector.length)
	for (let i = 0; i < vector.length; i++) {
		out[i] = vector[i] / norm
	}
	return out
}

export function dot(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length)
	let sum = 0
	for (let i = 0; i < n; i++) {
		sum += a[i] * b[i]
	}
	return sum
}
