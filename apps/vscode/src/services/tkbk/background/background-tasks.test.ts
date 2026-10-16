import { describe, expect, it } from "bun:test"
import {
	type BackgroundGitOps,
	type BackgroundTask,
	BackgroundTaskManager,
	type BackgroundTaskRunner,
	describeStatus,
	slugify,
} from "./background-tasks"

function flush(times = 4): Promise<void> {
	return new Promise((resolve) => {
		let n = 0
		const tick = () => (++n >= times ? resolve() : setImmediate(tick))
		setImmediate(tick)
	})
}

class FakeGit implements BackgroundGitOps {
	calls: string[] = []
	changed: string[] = ["src/a.ts"]
	applyError: Error | undefined
	async currentBranch(): Promise<string> {
		return "main"
	}
	async createWorktree(_repo: string, worktree: string, branch: string): Promise<void> {
		this.calls.push(`worktree:${branch}:${worktree}`)
	}
	async commitAll(): Promise<boolean> {
		this.calls.push("commit")
		return this.changed.length > 0
	}
	async changedFiles(): Promise<string[]> {
		return this.changed
	}
	async diff(): Promise<string> {
		return "diff --git a/src/a.ts b/src/a.ts"
	}
	async applyBranch(_repo: string, branch: string): Promise<void> {
		this.calls.push(`apply:${branch}`)
		if (this.applyError) {
			throw this.applyError
		}
	}
	async removeWorktree(): Promise<void> {
		this.calls.push("remove-worktree")
	}
	async deleteBranch(_repo: string, branch: string): Promise<void> {
		this.calls.push(`delete-branch:${branch}`)
	}
}

class ControlledRunner implements BackgroundTaskRunner {
	started: BackgroundTask[] = []
	private resolvers = new Map<string, (summary: string) => void>()
	private rejecters = new Map<string, (error: Error) => void>()
	run(task: BackgroundTask, signal: AbortSignal, onSession?: (id: string) => void): Promise<string> {
		this.started.push(task)
		onSession?.(`session-${task.id}`)
		return new Promise((resolve, reject) => {
			this.resolvers.set(task.id, resolve)
			this.rejecters.set(task.id, reject)
			signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
		})
	}
	finish(id: string, summary = "Готово"): void {
		this.resolvers.get(id)?.(summary)
	}
	fail(id: string, message: string): void {
		this.rejecters.get(id)?.(new Error(message))
	}
}

describe("slugify", () => {
	it("makes a short branch-safe slug and never returns empty", () => {
		expect(slugify("Добавить экспорт заказов в CSV")).toBe("добавить-экспорт-заказов-в-csv")
		expect(slugify("!!!")).toBe("task")
	})
})

describe("BackgroundTaskManager", () => {
	it("runs tasks up to the concurrency limit, then queues the rest with the reason", async () => {
		const git = new FakeGit()
		const runner = new ControlledRunner()
		const manager = new BackgroundTaskManager({
			git,
			runner,
			maxConcurrent: () => 1,
			limitReason: () => "Free: одна задача одновременно",
			worktreesRoot: () => "/wt",
		})
		const first = manager.enqueue({ title: "Первая", prompt: "сделай раз", repoPath: "/repo" })
		const second = manager.enqueue({ title: "Вторая", prompt: "сделай два", repoPath: "/repo" })
		await flush()

		expect(first.status).toBe("running")
		expect(first.baseBranch).toBe("main")
		expect(first.branch.startsWith("tkbk/первая-")).toBe(true)
		expect(first.sessionId).toBe(`session-${first.id}`)
		expect(second.status).toBe("queued")
		expect(describeStatus(second)).toContain("Free")
		expect(runner.started).toHaveLength(1)

		runner.finish(first.id, "Экспорт готов")
		await flush()
		expect(first.status).toBe("done")
		expect(first.summary).toBe("Экспорт готов")
		expect(first.changedFiles).toEqual(["src/a.ts"])
		expect(second.status).toBe("running")
	})

	it("applies a finished task onto the repo and cleans up worktree and branch", async () => {
		const git = new FakeGit()
		const runner = new ControlledRunner()
		const manager = new BackgroundTaskManager({ git, runner, maxConcurrent: () => 3, worktreesRoot: () => "/wt" })
		const task = manager.enqueue({ title: "Правка", prompt: "p", repoPath: "/repo" })
		await flush()
		runner.finish(task.id)
		await flush()

		await manager.apply(task.id)
		expect(task.status).toBe("applied")
		expect(git.calls).toEqual(
			expect.arrayContaining([`apply:${task.branch}`, "remove-worktree", `delete-branch:${task.branch}`]),
		)
	})

	it("keeps the task when applying conflicts, so the worktree stays available", async () => {
		const git = new FakeGit()
		git.applyError = new Error("conflict in src/a.ts")
		const runner = new ControlledRunner()
		const manager = new BackgroundTaskManager({ git, runner, maxConcurrent: () => 3, worktreesRoot: () => "/wt" })
		const task = manager.enqueue({ title: "Правка", prompt: "p", repoPath: "/repo" })
		await flush()
		runner.finish(task.id)
		await flush()

		await expect(manager.apply(task.id)).rejects.toThrow("conflict")
		expect(task.status).toBe("done")
		expect(task.error).toContain("conflict")
		expect(git.calls).not.toContain("remove-worktree")
	})

	it("rejects, cancels and records failures", async () => {
		const git = new FakeGit()
		const runner = new ControlledRunner()
		const manager = new BackgroundTaskManager({ git, runner, maxConcurrent: () => 3, worktreesRoot: () => "/wt" })
		const a = manager.enqueue({ title: "A", prompt: "a", repoPath: "/repo" })
		const b = manager.enqueue({ title: "B", prompt: "b", repoPath: "/repo" })
		const c = manager.enqueue({ title: "C", prompt: "c", repoPath: "/repo" })
		await flush()

		manager.cancel(a.id)
		await flush()
		expect(a.status).toBe("cancelled")

		runner.fail(b.id, "модель недоступна")
		await flush()
		expect(b.status).toBe("failed")
		expect(b.error).toBe("модель недоступна")

		runner.finish(c.id)
		await flush()
		await manager.reject(c.id)
		expect(c.status).toBe("rejected")
		expect(git.calls.filter((x) => x === "remove-worktree")).toHaveLength(1)
		expect(manager.list().map((t) => t.id)).toEqual(expect.arrayContaining([a.id, b.id, c.id]))
	})

	it("notifies listeners on every transition", async () => {
		const runner = new ControlledRunner()
		const manager = new BackgroundTaskManager({
			git: new FakeGit(),
			runner,
			maxConcurrent: () => 1,
			worktreesRoot: () => "/wt",
		})
		let changes = 0
		manager.onDidChange(() => changes++)
		const task = manager.enqueue({ title: "T", prompt: "t", repoPath: "/repo" })
		await flush()
		runner.finish(task.id)
		await flush()
		expect(changes).toBeGreaterThanOrEqual(4)
	})
})
