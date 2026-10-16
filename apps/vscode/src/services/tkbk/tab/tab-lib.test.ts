import { describe, expect, it } from "bun:test"
import {
	allowMultiline,
	buildTabRequest,
	extractTabText,
	isSensitiveFile,
	LruCache,
	postProcessTab,
	RecentEdits,
	reuseFromPrevious,
	tabStopSequences,
} from "./tab-lib"

describe("buildTabRequest", () => {
	it("uses OpenAI chat completions for non-Claude models, recent edits before PREFIX", () => {
		const r = buildTabRequest({
			baseUrl: "https://api.tkbk.online/v1/",
			apiKey: "cr_x",
			model: "deepseek-v4-pro",
			prefix: "a",
			suffix: "b",
			language: "ts",
			fileName: "x.ts",
			maxTokens: 64,
			stop: ["\n"],
			recentEdits: "src/a.ts:3\nconst a = 1",
		})
		expect(r.protocol).toBe("openai")
		expect(r.url).toBe("https://api.tkbk.online/v1/chat/completions")
		expect(r.headers.authorization).toBe("Bearer cr_x")
		const messages = r.body.messages as Array<{ role: string; content: string }>
		expect(messages[0].role).toBe("system")
		expect(messages[1].content.indexOf("<RECENT_EDITS>")).toBeLessThan(messages[1].content.indexOf("<PREFIX>"))
		expect(messages[1].content).toMatch(/<PREFIX>\na\n<\/PREFIX>\n<SUFFIX>\nb\n<\/SUFFIX>/)
		expect(r.body.stop).toEqual(["\n"])
	})

	it("uses Anthropic Messages for Claude models", () => {
		const r = buildTabRequest({ apiKey: "cr_x", model: "claude-sonnet-5", prefix: "a", suffix: "", maxTokens: 64, stop: [] })
		expect(r.protocol).toBe("anthropic")
		expect(r.url).toBe("https://api.tkbk.online/v1/messages")
		expect(r.headers["anthropic-version"]).toBe("2023-06-01")
		expect(r.body.stop_sequences).toBeUndefined()
		const messages = r.body.messages as Array<{ content: string }>
		expect(messages[0].content).not.toContain("<RECENT_EDITS>")
	})
})

describe("extractTabText", () => {
	it("reads both protocols", () => {
		expect(extractTabText({ content: [{ type: "text", text: "foo" }, { type: "tool_use" }] }, "anthropic")).toBe("foo")
		expect(extractTabText({ choices: [{ message: { content: "bar" } }] }, "openai")).toBe("bar")
		expect(extractTabText({ choices: [{ text: "baz" }] }, "openai")).toBe("baz")
		expect(extractTabText(null, "openai")).toBe("")
	})
})

describe("allowMultiline", () => {
	it("follows the policy and the cursor position", () => {
		expect(allowMultiline("always", "x", "y")).toBe(true)
		expect(allowMultiline("never", "", "")).toBe(false)
		expect(allowMultiline("auto", "if (a) {", "")).toBe(true)
		expect(allowMultiline("auto", "const a = foo(", "")).toBe(true)
		expect(allowMultiline("auto", "const a", ")")).toBe(false)
		expect(allowMultiline("auto", "return x", "")).toBe(false)
	})
})

describe("postProcessTab", () => {
	it("strips fences and tags, echoes of the current line and duplicated closers", () => {
		expect(postProcessTab("```ts\nconst a = 1\n```", { lineBefore: "", lineAfter: "", multiline: false })).toBe("const a = 1")
		expect(postProcessTab("const a = 1;", { lineBefore: "const a", lineAfter: "", multiline: false })).toBe(" = 1;")
		expect(postProcessTab("foo(bar))", { lineBefore: "", lineAfter: ")", multiline: false })).toBe("foo(bar)")
		expect(postProcessTab("\n\nline1\nline2", { lineBefore: "x", lineAfter: "", multiline: false })).toBe("line1")
		expect(postProcessTab("\n\n\nline1\nline2", { lineBefore: "", lineAfter: "", multiline: true })).toBe("\nline1\nline2")
		expect(postProcessTab("   ", { lineBefore: "", lineAfter: "", multiline: true })).toBe("")
	})

	it("discards attempted tool calls and trailing explanations, unwraps inline backticks", () => {
		const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="shell">cat src/pricing.js</｜｜DSML｜｜ invoke>'
		expect(postProcessTab(dsml, { lineBefore: "", lineAfter: "", multiline: true })).toBe("")
		expect(postProcessTab("<tool_call>{}</tool_call>", { lineBefore: "", lineAfter: "", multiline: false })).toBe("")
		expect(postProcessTab("return x;\n```\n\n`toFixed(2)` rounds…", { lineBefore: "", lineAfter: "", multiline: true })).toBe(
			"return x;",
		)
		expect(
			postProcessTab("`price * percent / 100`", { lineBefore: "  return price - ", lineAfter: ";", multiline: false }),
		).toBe("price * percent / 100")
	})

	it("drops completions that only echo lines already in the prefix", () => {
		const prefix = "// TKBK Tab demo\nfunction sum("
		expect(postProcessTab("// TKBK Tab demo", { lineBefore: "function sum(", lineAfter: "", multiline: false, prefix })).toBe(
			"",
		)
		expect(postProcessTab("a, b) {", { lineBefore: "function sum(", lineAfter: "", multiline: false, prefix })).toBe(
			"a, b) {",
		)
		expect(
			postProcessTab("// TKBK Tab demo\nfunction sum(", {
				lineBefore: "",
				lineAfter: "",
				multiline: true,
				prefix: `${prefix}\n`,
			}),
		).toBe("")
	})

	it("drops a verbatim repeat of the following lines", () => {
		const suffix = "\nreturn x\n}\n"
		expect(postProcessTab("const x = 1\nreturn x\n}", { lineBefore: "", lineAfter: "", multiline: true, suffix })).toBe(
			"const x = 1",
		)
	})
})

describe("reuseFromPrevious / LruCache / stops / sensitive files", () => {
	it("reuses the remainder when the user types through a completion", () => {
		expect(reuseFromPrevious({ prefix: "ab", text: "cdef" }, "abcd")).toBe("ef")
		expect(reuseFromPrevious({ prefix: "ab", text: "cdef" }, "abx")).toBeNull()
		expect(reuseFromPrevious({ prefix: "ab", text: "cdef" }, "ab")).toBe("cdef")
		expect(reuseFromPrevious(undefined, "ab")).toBeNull()
	})

	it("evicts the least recently used entry", () => {
		const cache = new LruCache<string>(2)
		cache.set("a", "1")
		cache.set("b", "2")
		cache.get("a")
		cache.set("c", "3")
		expect(cache.get("b")).toBeUndefined()
		expect(cache.get("a")).toBe("1")
	})

	it("stops and sensitive files", () => {
		expect(tabStopSequences(false)[0]).toBe("\n")
		expect(tabStopSequences(true)).not.toContain("\n")
		expect(isSensitiveFile("/p/.env.local")).toBe(true)
		expect(isSensitiveFile("C:\\p\\secrets.yaml")).toBe(true)
		expect(isSensitiveFile("/p/src/app.ts")).toBe(false)
	})
})

describe("RecentEdits", () => {
	it("keeps the newest, dedupes by file+line, expires and excludes the current file", () => {
		const edits = new RecentEdits(3, 1000)
		edits.record({ file: "a.ts", line: 1, snippet: "one" }, 0)
		edits.record({ file: "b.ts", line: 5, snippet: "five" }, 10)
		edits.record({ file: "a.ts", line: 1, snippet: "one-again" }, 20)
		edits.record({ file: "c.ts", line: 2, snippet: "   " }, 30)
		expect(edits.format(40)).toBe("a.ts:1\none-again\n---\nb.ts:5\nfive")
		expect(edits.format(40, "a.ts")).toBe("b.ts:5\nfive")
		edits.record({ file: "d.ts", line: 1, snippet: "d" }, 50)
		edits.record({ file: "e.ts", line: 1, snippet: "e" }, 60)
		expect(edits.size).toBe(3)
		expect(edits.format(2000)).toBe("")
	})
})
