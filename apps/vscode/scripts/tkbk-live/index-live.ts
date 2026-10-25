#!/usr/bin/env bun
/**
 * Live check of the codebase index against the TKBK gateway.
 *   TKBK_API_KEY=cr_… bun scripts/tkbk-live/index-live.ts <repo> [query…]
 * Builds the index with gateway embeddings (falls back to lexical on error),
 * prints status, timings, token usage and the top hits. Never prints the key.
 */
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { CodebaseIndex } from "../../src/services/tkbk/index/codebase-index"
import { GatewayEmbedder } from "../../src/services/tkbk/index/embedder"

const repo = path.resolve(process.argv[2] ?? ".")
const queries = process.argv.slice(3).length ? process.argv.slice(3) : ["где форматируется цена в рублях", "как хранятся заказы"]
const apiKey = process.env.TKBK_API_KEY?.trim()
const store = mkdtempSync(path.join(os.tmpdir(), "tkbk-index-live-"))
let tokens = 0
let requests = 0

const embedder = apiKey
	? new GatewayEmbedder({
			baseUrl: process.env.TKBK_BASE_URL ?? "https://api.tkbk.online/v1",
			apiKey,
			model: process.env.TKBK_EMBEDDING_MODEL ?? "text-embedding-3-small",
			onUsage: (u) => {
				tokens += u.totalTokens
				requests += 1
			},
		})
	: undefined

const index = new CodebaseIndex({ root: repo, storeDir: store, embedder, log: (m) => console.log(m) })
const t0 = performance.now()
await index.update()
const buildMs = Math.round(performance.now() - t0)
console.log("status:", JSON.stringify(index.status()))
console.log(
	`build: ${buildMs} ms, embedding requests: ${requests}, tokens: ${tokens}, est. cost $${((tokens / 1_000_000) * 0.02).toFixed(4)}`,
)
for (const q of queries) {
	const t1 = performance.now()
	const hits = await index.search(q, 3)
	console.log(`\nquery "${q}" (${Math.round(performance.now() - t1)} ms):`)
	for (const h of hits) {
		console.log(
			`  ${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine} via ${h.via.join("+")} score=${h.score.toFixed(4)}`,
		)
	}
}
rmSync(store, { recursive: true, force: true })
