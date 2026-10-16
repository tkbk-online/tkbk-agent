/**
 * Pure helpers for TKBK Tab (inline code completion through the TKBK gateway).
 * Ported from tkbk-ide/extensions/tkbk-complete/lib.js; no VS Code dependency,
 * covered by unit tests.
 */

export const TAB_SYSTEM_PROMPT = [
	"You are a code completion engine inside an IDE.",
	"You receive the text before the cursor (PREFIX) and after the cursor (SUFFIX), and sometimes the developer's RECENT_EDITS in other places of the project for context.",
	"Return ONLY the code to insert at the cursor: no explanations, no markdown fences, no repetition of PREFIX or SUFFIX.",
	"Never repeat a line that already exists in PREFIX; continue from the exact cursor position.",
	"Match the language, indentation and style of the surrounding code. Keep it short: finish the current statement or block.",
	"If nothing useful can be inserted, return an empty string.",
	"You have no tools and cannot run commands or read files: never emit tool calls, function-call markup or XML tags.",
].join(" ")

/** Tool-call markup some chat models emit when they try to act instead of completing. */
const TOOL_MARKUP_RE = /<[\u2502|｜]{1,2}DSML[\u2502|｜]{1,2}|<tool_call|<function_calls|<invoke\b|\[TOOL_CALL\]/i

const FENCE_RE = /^\s*```[a-zA-Z0-9_+-]*\s*\n?|\n?\s*```\s*$/g

export function isClaudeModel(model: string | undefined): boolean {
	return /^claude/i.test(String(model ?? ""))
}

export interface TabRequestInput {
	baseUrl?: string
	apiKey: string
	model: string
	prefix: string
	suffix: string
	language?: string
	fileName?: string
	maxTokens: number
	stop: string[]
	recentEdits?: string
}

export interface TabRequest {
	protocol: "anthropic" | "openai"
	url: string
	headers: Record<string, string>
	body: Record<string, unknown>
}

/**
 * Build the gateway request. The static system prompt goes first and the
 * dynamic parts last so the gateway's prompt cache keeps hitting on the stable
 * prefix.
 */
export function buildTabRequest(input: TabRequestInput): TabRequest {
	const base = String(input.baseUrl || "https://api.tkbk.online/v1").replace(/\/+$/, "")
	const recent = input.recentEdits?.trim() ? ["<RECENT_EDITS>", input.recentEdits.trim(), "</RECENT_EDITS>", ""] : []
	const user = [
		`File: ${input.fileName || "untitled"} (${input.language || "text"})`,
		"",
		...recent,
		"<PREFIX>",
		input.prefix,
		"</PREFIX>",
		"<SUFFIX>",
		input.suffix,
		"</SUFFIX>",
		"",
		"Insert at cursor:",
	].join("\n")
	const headers: Record<string, string> = {
		"content-type": "application/json",
		authorization: `Bearer ${input.apiKey}`,
		"user-agent": "tkbk-agent-tab/0.1.0",
	}
	const stop = input.stop.length ? input.stop : undefined
	if (isClaudeModel(input.model)) {
		headers["anthropic-version"] = "2023-06-01"
		headers["x-api-key"] = input.apiKey
		return {
			protocol: "anthropic",
			url: `${base}/messages`,
			headers,
			body: {
				model: input.model,
				max_tokens: input.maxTokens,
				temperature: 0,
				system: TAB_SYSTEM_PROMPT,
				messages: [{ role: "user", content: user }],
				stop_sequences: stop,
				metadata: { user_id: "tkbk-agent-tab" },
			},
		}
	}
	return {
		protocol: "openai",
		url: `${base}/chat/completions`,
		headers,
		body: {
			model: input.model,
			max_tokens: input.maxTokens,
			temperature: 0,
			messages: [
				{ role: "system", content: TAB_SYSTEM_PROMPT },
				{ role: "user", content: user },
			],
			stop,
			stream: false,
		},
	}
}

/** Extract completion text from a gateway response of either protocol. */
export function extractTabText(json: unknown, protocol: TabRequest["protocol"]): string {
	if (!json || typeof json !== "object") {
		return ""
	}
	const record = json as Record<string, unknown>
	if (protocol === "anthropic" || Array.isArray(record.content)) {
		return ((record.content as Array<{ type?: string; text?: string }> | undefined) ?? [])
			.filter((c) => c && c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("")
	}
	const choice = (record.choices as Array<Record<string, unknown>> | undefined)?.[0]
	if (!choice) {
		return ""
	}
	const message = choice.message as { content?: unknown } | undefined
	if (message && typeof message.content === "string") {
		return message.content
	}
	return typeof choice.text === "string" ? choice.text : ""
}

export type MultilinePolicy = "auto" | "always" | "never"

/** Decide whether a multi-line completion is appropriate for this cursor position. */
export function allowMultiline(policy: MultilinePolicy, lineBefore: string, lineAfter: string): boolean {
	if (policy === "always") {
		return true
	}
	if (policy === "never") {
		return false
	}
	if (lineAfter.trim() !== "") {
		return false
	}
	const before = lineBefore.trim()
	if (before === "") {
		return true
	}
	return /[{([:,=>]$|=>$|\b(then|do|else|try|finally)$/.test(before)
}

/** Longest suffix of `a` that is a prefix of `b`. */
export function longestOverlap(a: string, b: string): number {
	const max = Math.min(a.length, b.length)
	for (let n = max; n > 0; n--) {
		if (a.endsWith(b.slice(0, n))) {
			return n
		}
	}
	return 0
}

export interface PostProcessContext {
	lineBefore: string
	lineAfter: string
	multiline: boolean
	suffix?: string
	/** text before the cursor, used to drop echoes of existing lines */
	prefix?: string
}

/**
 * True when the completion is nothing but lines that already exist in the
 * PREFIX (a model echoing the file instead of continuing it).
 */
export function echoesPrefix(text: string, prefix: string | undefined): boolean {
	if (!prefix) {
		return false
	}
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
	if (lines.length === 0) {
		return false
	}
	const existing = new Set(
		prefix
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length >= 4),
	)
	return lines.every((l) => existing.has(l))
}

/** Clean the model output into an insertable snippet. */
export function postProcessTab(raw: string, ctx: PostProcessContext): string {
	let text = String(raw ?? "").replace(/\r\n/g, "\n")
	if (TOOL_MARKUP_RE.test(text)) {
		return ""
	}
	text = text.replace(FENCE_RE, "")
	// A fence after the code means the model went on to explain: keep only the code.
	const fenceAt = text.indexOf("```")
	if (fenceAt >= 0) {
		text = text.slice(0, fenceAt).trimEnd()
	}
	text = text.replace(/<\/?(PREFIX|SUFFIX|CURSOR)>/g, "")
	// Single-line answers wrapped in inline backticks.
	if (!ctx.multiline) {
		const inline = text.trim().match(/^`([^`\n]+)`$/)
		if (inline) {
			text = inline[1]
		}
	}
	if (!text.trim()) {
		return ""
	}

	const lineBefore = ctx.lineBefore || ""
	if (lineBefore.trim()) {
		const trimmedBefore = lineBefore.trimStart()
		if (text.startsWith(lineBefore)) {
			text = text.slice(lineBefore.length)
		} else if (text.startsWith(trimmedBefore)) {
			text = text.slice(trimmedBefore.length)
		} else {
			const n = longestOverlap(lineBefore, text)
			if (n >= 3) {
				text = text.slice(n)
			}
		}
	}
	if (lineBefore.trim() === "" && lineBefore.length && text.startsWith(lineBefore)) {
		text = text.slice(lineBefore.length)
	}

	if (!ctx.multiline) {
		text = text.replace(/^\n+/, "")
		const nl = text.indexOf("\n")
		if (nl >= 0) {
			text = text.slice(0, nl)
		}
	} else {
		text = text.replace(/^\n{2,}/, "\n")
	}
	if (echoesPrefix(text, ctx.prefix)) {
		return ""
	}

	const lineAfter = ctx.lineAfter || ""
	if (lineAfter.trim()) {
		const after = lineAfter.trimEnd()
		if (text.endsWith(after)) {
			text = text.slice(0, text.length - after.length)
		} else {
			const n = longestOverlap(text, after)
			if (n > 0 && /^[)\]}>"'`;,]+$/.test(after.slice(0, n))) {
				text = text.slice(0, text.length - n)
			}
		}
	}
	if (ctx.multiline && ctx.suffix) {
		const nextLines = ctx.suffix
			.replace(/^[^\n]*\n?/, "")
			.split("\n")
			.slice(0, 3)
			.join("\n")
			.trim()
		if (nextLines && text.trim().endsWith(nextLines)) {
			text = text.trimEnd()
			text = text.slice(0, text.length - nextLines.length).trimEnd()
		}
	}
	return text.trim() ? text : ""
}

/** Small LRU cache keyed by string. */
export class LruCache<V> {
	readonly map = new Map<string, V>()
	constructor(private readonly limit = 64) {}
	get(key: string): V | undefined {
		if (!this.map.has(key)) {
			return undefined
		}
		const value = this.map.get(key) as V
		this.map.delete(key)
		this.map.set(key, value)
		return value
	}
	set(key: string, value: V): void {
		if (this.map.has(key)) {
			this.map.delete(key)
		}
		this.map.set(key, value)
		while (this.map.size > this.limit) {
			this.map.delete(this.map.keys().next().value as string)
		}
	}
	clear(): void {
		this.map.clear()
	}
}

export interface PreviousCompletion {
	prefix: string
	text: string
}

/**
 * If the user typed a few characters that match the beginning of a previous
 * completion produced for a shorter prefix, return the remaining part instead
 * of asking again.
 */
export function reuseFromPrevious(prev: PreviousCompletion | undefined, prefix: string): string | null {
	if (!prev || !prefix.startsWith(prev.prefix)) {
		return null
	}
	const typed = prefix.slice(prev.prefix.length)
	if (!typed || typed.includes("\n")) {
		return typed === "" ? prev.text : null
	}
	if (!prev.text.startsWith(typed)) {
		return null
	}
	const rest = prev.text.slice(typed.length)
	return rest.trim() ? rest : null
}

const SENSITIVE_FILE_RE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx|kdbx)|id_rsa.*|secrets?\.(json|ya?ml|toml))$/i

export function isSensitiveFile(fileName: string | undefined): boolean {
	return SENSITIVE_FILE_RE.test(String(fileName ?? ""))
}

export function tabStopSequences(multiline: boolean): string[] {
	return multiline ? ["</SUFFIX>", "<SUFFIX>", "```"] : ["\n", "</SUFFIX>", "```"]
}

export interface RecentEdit {
	file: string
	line: number
	snippet: string
}

/**
 * The developer's latest edits across files: a few short snippets the model
 * sees as extra context. Deduplicated by file + line, newest first, forgotten
 * after `maxAgeMs`.
 */
export class RecentEdits {
	private items: Array<RecentEdit & { key: string; at: number }> = []
	constructor(
		private readonly limit = 5,
		private readonly maxAgeMs = 5 * 60_000,
		private readonly snippetChars = 240,
	) {}

	record(edit: RecentEdit, now = Date.now()): void {
		const snippet = String(edit.snippet ?? "").replace(/\s+$/, "")
		if (!snippet.trim()) {
			return
		}
		const key = `${edit.file}:${edit.line}`
		this.items = this.items.filter((it) => it.key !== key)
		this.items.unshift({ key, file: edit.file, line: edit.line, snippet: snippet.slice(0, this.snippetChars), at: now })
		this.items = this.items.slice(0, this.limit)
	}

	/** Compact block for the prompt; `excludeFile` drops edits in the file being completed. */
	format(now = Date.now(), excludeFile?: string): string {
		this.items = this.items.filter((it) => now - it.at <= this.maxAgeMs)
		return this.items
			.filter((it) => !excludeFile || it.file !== excludeFile)
			.map((it) => `${it.file}:${it.line}\n${it.snippet}`)
			.join("\n---\n")
	}

	get size(): number {
		return this.items.length
	}

	clear(): void {
		this.items = []
	}
}
