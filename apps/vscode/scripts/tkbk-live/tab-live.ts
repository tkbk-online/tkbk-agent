#!/usr/bin/env bun
/**
 * Live check of TKBK Tab requests against the gateway.
 *   TKBK_API_KEY=cr_… bun scripts/tkbk-live/tab-live.ts [model]
 * Sends a few FIM prompts (single- and multi-line), prints latency, raw and
 * post-processed completions, and the reported token usage. Never prints the key.
 */
import {
	allowMultiline,
	buildTabRequest,
	extractTabText,
	postProcessTab,
	RecentEdits,
	tabStopSequences,
} from "../../src/services/tkbk/tab/tab-lib"

const apiKey = process.env.TKBK_API_KEY?.trim()
if (!apiKey) {
	console.error("TKBK_API_KEY is not set")
	process.exit(1)
}
const model = process.argv[2] ?? "deepseek-v4.1-flash"

const cases = [
	{
		name: "single-line: finish an expression",
		prefix: 'export function applyDiscount(price, percent) {\n  if (percent < 0 || percent > 100) throw new Error("percent out of range");\n  return price - ',
		suffix: ";\n}\n",
		lineBefore: "  return price - ",
		lineAfter: ";",
	},
	{
		name: "multi-line: body after an opening brace",
		prefix: "// Format an amount as rubles with two decimals and a comma separator.\nexport function formatRub(amount) {\n",
		suffix: "}\n\nexport function totalWithVat(items, vatPercent = 20) {\n",
		lineBefore: "",
		lineAfter: "",
	},
]

const recent = new RecentEdits()
recent.record({ file: "tests/pricing.test.js", line: 9, snippet: 'assert.equal(formatRub(1234.5678), "1234,57 ₽");' })

let totalTokens = 0
for (const c of cases) {
	const multiline = allowMultiline("auto", c.lineBefore, c.lineAfter)
	const req = buildTabRequest({
		apiKey,
		model,
		prefix: c.prefix,
		suffix: c.suffix,
		language: "javascript",
		fileName: "src/pricing.js",
		recentEdits: recent.format(Date.now(), "src/pricing.js"),
		maxTokens: multiline ? 160 : 64,
		stop: tabStopSequences(multiline),
	})
	const t0 = performance.now()
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 15_000)
	try {
		const res = await fetch(req.url, {
			method: "POST",
			headers: req.headers,
			body: JSON.stringify(req.body),
			signal: controller.signal,
		})
		const ms = Math.round(performance.now() - t0)
		const json = (await res.json()) as { usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } }
		const usage = json.usage ?? {}
		totalTokens += usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
		const raw = extractTabText(json, req.protocol)
		const text = postProcessTab(raw, { lineBefore: c.lineBefore, lineAfter: c.lineAfter, multiline, suffix: c.suffix })
		console.log(`\n== ${c.name} [${res.status}, ${ms} ms, multiline=${multiline}]`)
		console.log("raw:", JSON.stringify(raw))
		console.log("insert:", JSON.stringify(text))
	} finally {
		clearTimeout(timer)
	}
}
console.log(`\ntokens total: ${totalTokens}`)
