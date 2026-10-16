import { type CodeChunk, tokenize } from "./chunker"

export interface ScoredChunk {
	chunk: CodeChunk
	score: number
}

/**
 * BM25 over chunk tokens. Small, dependency-free and fast enough for tens of
 * thousands of chunks; rebuilt from the chunk list on load, never persisted.
 * It is the fallback when no embeddings are available and the second leg of
 * the hybrid ranking when they are.
 */
export class LexicalIndex {
	private readonly chunks: CodeChunk[] = []
	private readonly docLengths: number[] = []
	private readonly postings = new Map<string, Map<number, number>>()
	private totalLength = 0

	constructor(chunks: Iterable<CodeChunk> = []) {
		for (const chunk of chunks) {
			this.add(chunk)
		}
	}

	get size(): number {
		return this.chunks.length
	}

	add(chunk: CodeChunk): void {
		const docId = this.chunks.length
		// The path is part of the document: "where is the login route" should
		// find routes/login.ts even when the file never says "login" inside.
		const tokens = tokenize(`${chunk.path.replace(/[/.-]/g, " ")} ${chunk.text}`)
		this.chunks.push(chunk)
		this.docLengths.push(tokens.length)
		this.totalLength += tokens.length
		for (const token of tokens) {
			let posting = this.postings.get(token)
			if (!posting) {
				posting = new Map()
				this.postings.set(token, posting)
			}
			posting.set(docId, (posting.get(docId) ?? 0) + 1)
		}
	}

	search(query: string, limit = 20): ScoredChunk[] {
		const n = this.chunks.length
		if (n === 0) {
			return []
		}
		const k1 = 1.2
		const b = 0.75
		const avgLength = this.totalLength / n
		const scores = new Map<number, number>()
		const queryTokens = Array.from(new Set(tokenize(query)))
		for (const token of queryTokens) {
			const posting = this.postings.get(token)
			if (!posting) {
				continue
			}
			const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5))
			for (const [docId, tf] of posting) {
				const length = this.docLengths[docId]
				const denominator = tf + k1 * (1 - b + (b * length) / avgLength)
				scores.set(docId, (scores.get(docId) ?? 0) + idf * ((tf * (k1 + 1)) / denominator))
			}
		}
		return Array.from(scores.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([docId, score]) => ({ chunk: this.chunks[docId], score }))
	}
}
