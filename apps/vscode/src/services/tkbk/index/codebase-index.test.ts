import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chunkFile, tokenize } from "./chunker"
import { CodebaseIndex, fuseRankings, listIndexableFiles } from "./codebase-index"
import { formatSearchHits } from "./codebase-search-tool"
import { type Embedder, GatewayEmbedder, normalize } from "./embedder"
import { LexicalIndex } from "./lexical"

describe("chunker", () => {
	it("splits a long file into overlapping chunks that break at symbol boundaries", () => {
		const lines: string[] = []
		for (let i = 0; i < 5; i++) {
			lines.push(`export function handler${i}() {`)
			for (let j = 0; j < 20; j++) {
				lines.push(`  const value${j} = ${j}`)
			}
			lines.push("}")
			lines.push("")
		}
		const chunks = chunkFile("src/a.ts", lines.join("\n"), { maxLines: 50, overlapLines: 5 })
		expect(chunks.length).toBeGreaterThan(1)
		expect(chunks[0].startLine).toBe(1)
		// Second chunk starts at (or just before) a function boundary thanks to the overlap.
		expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine)
		expect(chunks.at(-1)?.endLine).toBe(lines.length)
		expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length)
	})

	it("returns nothing for empty files", () => {
		expect(chunkFile("x.txt", "   \n\n")).toEqual([])
	})

	it("tokenises identifiers into whole names and parts", () => {
		expect(tokenize("getUserById snake_case_name")).toEqual(
			expect.arrayContaining(["getuserbyid", "get", "user", "by", "id", "snake_case_name", "snake", "case", "name"]),
		)
	})
})

describe("LexicalIndex", () => {
	it("ranks the chunk that mentions the query terms (and the path) first", () => {
		const index = new LexicalIndex([
			{
				id: "1",
				path: "src/auth/login.ts",
				startLine: 1,
				endLine: 5,
				text: "export async function loginUser(req) { return session.create(req.user) }",
			},
			{ id: "2", path: "src/db/pool.ts", startLine: 1, endLine: 5, text: "const pool = new Pool({ max: 10 })" },
			{ id: "3", path: "README.md", startLine: 1, endLine: 2, text: "# Project" },
		])
		const hits = index.search("where is user login handled")
		expect(hits[0].chunk.id).toBe("1")
		expect(index.search("zzzz-nothing")).toEqual([])
	})
})

describe("fuseRankings", () => {
	it("prefers fragments found by both legs", () => {
		const a = { id: "a", path: "a", startLine: 1, endLine: 1, text: "a" }
		const b = { id: "b", path: "b", startLine: 1, endLine: 1, text: "b" }
		const c = { id: "c", path: "c", startLine: 1, endLine: 1, text: "c" }
		const fused = fuseRankings(
			[
				{ chunk: a, score: 0.9 },
				{ chunk: b, score: 0.8 },
			],
			[
				{ chunk: c, score: 5 },
				{ chunk: b, score: 4 },
			],
			3,
		)
		expect(fused[0].chunk.id).toBe("b")
		expect(fused[0].via).toEqual(["semantic", "lexical"])
		expect(fused).toHaveLength(3)
	})
})

describe("GatewayEmbedder", () => {
	it("posts batches to /embeddings and returns unit vectors in input order", async () => {
		const calls: Array<{ url: string; body: { model: string; input: string[] } }> = []
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { model: string; input: string[] }
			calls.push({ url: String(url), body })
			return new Response(
				JSON.stringify({
					data: body.input.map((_, i) => ({
						index: body.input.length - 1 - i,
						embedding: [body.input.length - 1 - i + 1, 0, 0],
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)
		}) as unknown as typeof fetch
		const embedder = new GatewayEmbedder({
			baseUrl: "https://api.tkbk.online/v1/",
			apiKey: "cr_test",
			model: "emb",
			fetchImpl,
			batchSize: 2,
		})
		const vectors = await embedder.embed(["a", "b", "c"])
		expect(calls.map((c) => c.url)).toEqual([
			"https://api.tkbk.online/v1/embeddings",
			"https://api.tkbk.online/v1/embeddings",
		])
		expect(calls[0].body.input).toEqual(["a", "b"])
		expect(vectors).toHaveLength(3)
		expect(Array.from(vectors[0])).toEqual([1, 0, 0])
		expect(Array.from(normalize(Float32Array.from([3, 4])))).toEqual([0.6000000238418579, 0.800000011920929])
	})

	it("surfaces non-2xx as EmbeddingUnavailableError with the status", async () => {
		const fetchImpl = (async () => new Response("no such model", { status: 404 })) as unknown as typeof fetch
		const embedder = new GatewayEmbedder({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl })
		await expect(embedder.embed(["a"])).rejects.toMatchObject({ name: "EmbeddingUnavailableError", status: 404 })
	})
})

describe("CodebaseIndex (lexical, on disk)", () => {
	let root: string
	let store: string

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "tkbk-index-root-"))
		store = await mkdtemp(path.join(os.tmpdir(), "tkbk-index-store-"))
		await mkdir(path.join(root, "src", "auth"), { recursive: true })
		await mkdir(path.join(root, "node_modules", "dep"), { recursive: true })
		await writeFile(
			path.join(root, "src", "auth", "login.ts"),
			"export async function loginUser(req) {\n  return createSession(req.user)\n}\n",
		)
		await writeFile(
			path.join(root, "src", "billing.ts"),
			"export function chargeCard(card) {\n  return stripe.charge(card)\n}\n",
		)
		await writeFile(path.join(root, "node_modules", "dep", "index.js"), "module.exports = () => 'loginUser everywhere'\n")
		await writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
		await rm(store, { recursive: true, force: true })
	})

	it("indexes source files, skips dependencies and binaries, searches, persists and updates incrementally", async () => {
		const files = await listIndexableFiles(root)
		expect(files.sort()).toEqual(["src/auth/login.ts", "src/billing.ts"])

		const index = new CodebaseIndex({ root, storeDir: store })
		await index.update()
		expect(index.status()).toMatchObject({ files: 2, mode: "lexical", building: false })

		const hits = await index.search("user login session", 5)
		expect(hits[0].chunk.path).toBe("src/auth/login.ts")
		expect(hits[0].via).toEqual(["lexical"])

		// Persisted copy loads back.
		const reloaded = new CodebaseIndex({ root, storeDir: store })
		expect(await reloaded.load()).toBe(true)
		expect(reloaded.status().chunks).toBe(index.status().chunks)

		// Incremental update: a new file joins, a deleted one leaves.
		await writeFile(path.join(root, "src", "search.ts"), "export function semanticSearch(query) {}\n")
		await rm(path.join(root, "src", "billing.ts"))
		await reloaded.update(["src/search.ts", "src/billing.ts"])
		expect(Object.keys(reloaded.status()).length).toBeGreaterThan(0)
		const afterHits = await reloaded.search("semantic search query", 3)
		expect(afterHits[0].chunk.path).toBe("src/search.ts")
		expect((await reloaded.search("charge card stripe", 3)).some((h) => h.chunk.path === "src/billing.ts")).toBe(false)
	})

	it("falls back to lexical mode when the embedder is unavailable", async () => {
		const failing: Embedder = {
			id: "gateway:broken",
			embed: async () => {
				const { EmbeddingUnavailableError } = await import("./embedder")
				throw new EmbeddingUnavailableError("HTTP 404", 404)
			},
		}
		const index = new CodebaseIndex({ root, storeDir: store, embedder: failing })
		await index.update()
		expect(index.status().mode).toBe("lexical")
		expect(index.status().lastError).toContain("лексический")
		expect((await index.search("login user")).length).toBeGreaterThan(0)
	})

	it("uses vectors when the embedder works and marks hits as semantic", async () => {
		const fake: Embedder = {
			id: "gateway:fake",
			embed: async (texts) =>
				texts.map((t) =>
					normalize(
						Float32Array.from([
							t.includes("login") || t.includes("Login") ? 1 : 0,
							t.includes("charge") ? 1 : 0,
							0.01,
						]),
					),
				),
		}
		const index = new CodebaseIndex({ root, storeDir: store, embedder: fake })
		await index.update()
		expect(index.status().mode).toBe("gateway:fake")
		const hits = await index.search("login", 2)
		expect(hits[0].chunk.path).toBe("src/auth/login.ts")
		expect(hits[0].via).toContain("semantic")
		expect(formatSearchHits(hits, "login")).toContain("src/auth/login.ts:1-")
	})
})
