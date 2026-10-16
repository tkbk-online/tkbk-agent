import { type AgentTool, createTool } from "@cline/shared"
import { z } from "zod"
import type { CodebaseIndex, SearchHit } from "./codebase-index"

export const CODEBASE_SEARCH_TOOL_NAME = "codebase_search"

const CodebaseSearchInputSchema = z.object({
	query: z
		.string()
		.min(1)
		.describe(
			"What you are looking for, in natural language or with identifiers: 'where is the login route handled', 'retry logic for the embeddings request', 'class that parses SKILL.md'.",
		),
	maxResults: z.number().int().min(1).max(30).optional().describe("How many fragments to return (default 8)."),
})

export type CodebaseSearchInput = z.infer<typeof CodebaseSearchInputSchema>

const SNIPPET_LINES = 24

/** Compact, model-friendly rendering: path:lines, then the snippet. */
export function formatSearchHits(hits: SearchHit[], query: string): string {
	if (hits.length === 0) {
		return `No indexed fragments matched "${query}". Try other words or identifiers, or use search_codebase (grep) for exact strings.`
	}
	const blocks = hits.map((hit, i) => {
		const lines = hit.chunk.text.split("\n")
		const shown = lines.slice(0, SNIPPET_LINES)
		const more =
			lines.length > shown.length ? `\n… (${lines.length - shown.length} more lines, read the file for the rest)` : ""
		return `### ${i + 1}. ${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine} (${hit.via.join("+")})\n${shown.join("\n")}${more}`
	})
	return `Top ${hits.length} fragments for "${query}":\n\n${blocks.join("\n\n")}`
}

/**
 * `codebase_search`: semantic + lexical search over the workspace index.
 * Complements the SDK's grep-style `search_codebase`: this one answers
 * "where is X implemented" without knowing the exact string.
 */
export function createCodebaseSearchTool(getIndex: () => CodebaseIndex | undefined): AgentTool {
	return createTool({
		name: CODEBASE_SEARCH_TOOL_NAME,
		description:
			"Semantic search over the indexed workspace: finds the code fragments most relevant to a question or description, even when you do not know the exact identifier. Returns paths with line ranges and snippets. Use it first when exploring unfamiliar code; use search_codebase (grep) afterwards for exact strings.",
		inputSchema: CodebaseSearchInputSchema,
		executionMode: "parallel",
		execute: async (input, context) => {
			const index = getIndex()
			if (!index) {
				return "The codebase index is not available in this workspace (disabled in settings or no workspace folder). Use search_codebase instead."
			}
			const status = index.status()
			if (status.chunks === 0) {
				return status.building
					? "The codebase index is still being built; retry in a few seconds or use search_codebase meanwhile."
					: "The codebase index is empty for this workspace. Use search_codebase instead."
			}
			const hits = await index.search(input.query, input.maxResults ?? 8, context.signal)
			return formatSearchHits(hits, input.query)
		},
	}) as unknown as AgentTool
}
