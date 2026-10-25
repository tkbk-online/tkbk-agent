#!/usr/bin/env bun
/**
 * Live check of a local background task end to end on a real git repository:
 * worktree → headless agent (ClineCore, TKBK provider) → commit on the task
 * branch → diff → apply (3-way) onto the repository → worktree/branch removed.
 *   TKBK_API_KEY=cr_… bun scripts/tkbk-live/background-live.ts <repo> [model] "<prompt>"
 * Prints progress and the agent's report; never prints the key.
 */
import { ClineCore } from "@cline/core"
import simpleGit from "simple-git"
import {
	type BackgroundTask,
	BackgroundTaskManager,
	type BackgroundTaskRunner,
} from "../../src/services/tkbk/background/background-tasks"
import { SimpleGitOps } from "../../src/services/tkbk/background/git-ops"

const apiKey = process.env.TKBK_API_KEY?.trim() ?? ""
const repo = process.argv[2]
const model = process.argv[3] ?? "claude-sonnet-5"
const prompt =
	process.argv[4] ??
	"В src/pricing.js функция formatRub должна округлять сумму до двух знаков и использовать запятую как десятичный разделитель (ожидается `1234,57 ₽`). Исправь её минимально, запусти `node --test tests/` и убедись, что тесты проходят. Больше ничего не меняй. В конце — две строки отчёта."
if (!apiKey || !repo) {
	console.error("usage: TKBK_API_KEY=… bun background-live.ts <repo> [model] [prompt]")
	process.exit(1)
}

const SYSTEM_PROMPT = [
	"You are TKBK Agent running headless in a git worktree. No one answers questions; decide yourself and report decisions.",
	"Edit only files inside the current working directory. Do not commit, push or switch branches.",
	"Run the project's tests when they exist. Finish with a short report in Russian: what changed, what was verified.",
].join(" ")

let usage = { input: 0, output: 0 }

const runner: BackgroundTaskRunner = {
	async run(task: BackgroundTask, signal: AbortSignal, onSession?: (id: string) => void) {
		const core = await ClineCore.create({ backendMode: "local", toolPolicies: { "*": { autoApprove: true } } })
		const started = await core.start({
			config: {
				providerId: "tkbk",
				modelId: model,
				apiKey,
				cwd: task.worktreePath,
				workspaceRoot: task.worktreePath,
				systemPrompt: SYSTEM_PROMPT,
				mode: "act",
				enableTools: true,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				maxIterations: 25,
			},
			interactive: false,
			mode: "background",
			toolPolicies: { "*": { autoApprove: true } },
		})
		onSession?.(started.sessionId)
		const unsubscribe = core.subscribe((event) => {
			if (event.type === "agent_event") {
				const e = event.payload.event as { type?: string; toolName?: string; contentType?: string }
				if (e.type === "content_start" && e.contentType === "tool") {
					console.log(`  tool: ${e.toolName}`)
				}
			}
		})
		const abort = () => void core.abort(started.sessionId, new Error("cancelled")).catch(() => undefined)
		signal.addEventListener("abort", abort, { once: true })
		try {
			const t0 = performance.now()
			await core.send({ sessionId: started.sessionId, prompt: task.prompt })
			console.log(`  agent turn: ${Math.round((performance.now() - t0) / 1000)} s`)
			const acc = await core.getAccumulatedUsage(started.sessionId)
			if (acc?.usage) {
				usage = { input: acc.usage.inputTokens, output: acc.usage.outputTokens }
			}
			const messages = await core.readDisplayMessages(started.sessionId)
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i]?.message
				if (m?.role === "assistant") {
					const text = Array.isArray(m.content)
						? m.content
								.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
								.join("")
						: String(m.content ?? "")
					if (text.trim()) {
						return text.trim()
					}
				}
			}
			return "(отчёт не найден)"
		} finally {
			unsubscribe()
			signal.removeEventListener("abort", abort)
			await core.stop(started.sessionId).catch(() => undefined)
			await core.dispose("live done").catch(() => undefined)
		}
	},
}

const manager = new BackgroundTaskManager({
	git: new SimpleGitOps(),
	runner,
	maxConcurrent: () => 1,
	log: (m) => console.log(m),
})
manager.onDidChange(() => undefined)
const task = manager.enqueue({ title: "formatRub", prompt, repoPath: repo })
console.log(`task ${task.id}: worktree ${task.worktreePath}, branch ${task.branch}`)
await new Promise<void>((resolve) => {
	const check = () => (["done", "failed", "cancelled"].includes(task.status) ? resolve() : setTimeout(check, 500))
	check()
})
console.log(`status=${task.status} changed=${JSON.stringify(task.changedFiles)} error=${task.error ?? "-"}`)
console.log("report:\n" + (task.summary ?? "").slice(0, 800))
console.log(`usage: input=${usage.input} output=${usage.output}`)
if (task.status === "done") {
	const diff = await manager.diff(task.id)
	console.log(`diff lines: ${diff.split("\n").length}`)
	await manager.apply(task.id)
	console.log(`apply → status=${task.status}`)
	const status = await simpleGit(repo).status()
	console.log(`repo working tree after apply: ${status.files.map((f) => `${f.index}${f.working_dir} ${f.path}`).join(", ")}`)
	const worktrees = await simpleGit(repo).raw(["worktree", "list"])
	console.log(`worktrees now:\n${worktrees.trim()}`)
}
process.exit(0)
