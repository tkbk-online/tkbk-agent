#!/usr/bin/env bun
/**
 * Live check of configured subagent roles through ClineCore (the same runtime
 * the extension uses, `enableSpawnAgent: true`): the parent on the given model
 * must call `subagent_explore` (fast model from the role file) and
 * `subagent_review`, then summarise. Prints tool calls, per-role models and
 * token usage; never prints the key.
 *   TKBK_API_KEY=cr_… bun scripts/tkbk-live/subagents-live.ts <repo> [model]
 */
import { ClineCore } from "@cline/core"

const apiKey = process.env.TKBK_API_KEY?.trim() ?? ""
const repo = process.argv[2]
const model = process.argv[3] ?? "claude-sonnet-5"
if (!apiKey || !repo) {
	console.error("usage: TKBK_API_KEY=… bun subagents-live.ts <repo> [model]")
	process.exit(1)
}

const prompt = [
	"Ничего не правь в файлах.",
	"Сначала вызови инструмент subagent_explore с заданием: «Какой тест в этом проекте падает и в какой функции причина? Укажи файл и строки».",
	"Затем вызови инструмент subagent_review с заданием: «Оцени src/pricing.js: ошибки, граничные случаи, что исправить».",
	"Дождись обоих отчётов и перескажи их мне в 6–8 строках, указав, какие инструменты ты вызвал.",
].join(" ")

const core = await ClineCore.create({ backendMode: "local", toolPolicies: { "*": { autoApprove: true } } })
const started = await core.start({
	config: {
		providerId: "tkbk",
		modelId: model,
		apiKey,
		cwd: repo,
		workspaceRoot: repo,
		systemPrompt: "You are TKBK Agent. Use the subagent_* tools when the user asks for them. Answer in Russian.",
		mode: "act",
		enableTools: true,
		enableSpawnAgent: true,
		enableAgentTeams: false,
		maxIterations: 20,
	},
	interactive: false,
	mode: "background",
	toolPolicies: { "*": { autoApprove: true } },
})
const toolCalls: string[] = []
const unsubscribe = core.subscribe((event) => {
	if (event.type !== "agent_event") {
		return
	}
	const e = event.payload.event as { type?: string; toolName?: string; contentType?: string; agentId?: string }
	if (e.type === "content_start" && e.contentType === "tool") {
		toolCalls.push(e.toolName ?? "?")
		console.log(`  tool: ${e.toolName}`)
	}
})
const t0 = performance.now()
try {
	await core.send({ sessionId: started.sessionId, prompt })
	console.log(`turn: ${Math.round((performance.now() - t0) / 1000)} s`)
	const acc = await core.getAccumulatedUsage(started.sessionId)
	console.log(`usage (parent, accumulated): ${JSON.stringify(acc?.usage ?? acc)}`)
	const messages = await core.readDisplayMessages(started.sessionId)
	let report = ""
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]?.message
		if (m?.role === "assistant") {
			const text = Array.isArray(m.content)
				? m.content.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("")
				: String(m.content ?? "")
			if (text.trim()) {
				report = text.trim()
				break
			}
		}
	}
	console.log(`tools called: ${toolCalls.join(", ") || "(none)"}`)
	console.log("report:\n" + report.slice(0, 1500))
} finally {
	unsubscribe()
	await core.stop(started.sessionId).catch(() => undefined)
	await core.dispose("live done").catch(() => undefined)
}
process.exit(0)
