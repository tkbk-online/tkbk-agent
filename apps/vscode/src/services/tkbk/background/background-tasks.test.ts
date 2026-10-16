import { describe, expect, it } from "bun:test"
import type { CloudBackend } from "../cloud/cloud-backend"
import type { AgentEvent, CreateTaskRequest, Me, Task } from "../cloud/tkbkCloudAgents"
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
	remote: string | undefined = "https://github.com/tkbk-online/demo"
	dirty = false
	async remoteUrl(): Promise<string | undefined> {
		return this.remote
	}
	async isDirty(): Promise<boolean> {
		return this.dirty
	}
	async applyPatch(_repo: string, patch: string): Promise<void> {
		this.calls.push(`apply-patch:${patch.length}`)
	}
}

class FakeCloud implements CloudBackend {
	created: CreateTaskRequest[] = []
	cancelled: string[] = []
	plan = "pro"
	cloudAgents = true
	patch = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n"
	async me(): Promise<Me> {
		return {
			ok: true,
			key_id: "k",
			key_prefix: "cr_",
			plan: this.plan,
			cloud_agents: this.cloudAgents,
			hours_month: 20,
			minutes_used: 10,
			minutes_left: 1190,
			concurrent_limit: 3,
			active_tasks: 0,
			until: null,
			error: null,
		}
	}
	async createTask(req: CreateTaskRequest): Promise<{ task: Task; uploadUrl?: string }> {
		this.created.push(req)
		return { task: { id: "t_1", status: "queued", phase: "queued", work_branch: "tkbk/t_1" } as unknown as Task }
	}
	async *events(): AsyncGenerator<AgentEvent> {
		yield { seq: 1, ts: "", type: "status", status: "running", phase: "agent" }
		yield {
			seq: 2,
			ts: "",
			type: "agent",
			kind: "action",
			tool: "terminal",
			text: "pytest -q",
			thought: "Run the suite first",
		}
		yield {
			seq: 3,
			ts: "",
			type: "done",
			status: "done",
			error: null,
			minutes_billed: 4,
			result: {
				patch_url: "x",
				archive_url: null,
				log_url: null,
				pr_url: null,
				branch: "tkbk/t_1",
				pushed: false,
				commit: "abc",
				changed_files: ["src/x.ts"],
				summary: "Сделано",
				commands: 3,
			},
		}
	}
	async diff(): Promise<string> {
		return this.patch
	}
	async cancel(id: string): Promise<Task> {
		this.cancelled.push(id)
		return { id, status: "cancelled" } as unknown as Task
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

describe("BackgroundTaskManager (cloud)", () => {
	function make(git = new FakeGit(), cloud = new FakeCloud()) {
		const manager = new BackgroundTaskManager({
			git,
			runner: new ControlledRunner(),
			maxConcurrent: () => 1,
			cloud: () => cloud,
			cloudSettings: () => ({ serverUrl: "https://agents.tkbk.online", model: "", maxMinutes: 45 }),
		})
		return { manager, git, cloud }
	}

	it("sends the repo and branch to the orchestrator, streams progress and applies the returned patch", async () => {
		const { manager, git, cloud } = make()
		const task = manager.enqueueCloud({ title: "Тесты", prompt: "добавь тесты", repoPath: "/repo" })
		await flush(8)

		expect(cloud.created[0]).toMatchObject({
			repoUrl: "https://github.com/tkbk-online/demo",
			branch: "main",
			prompt: "добавь тесты",
			maxMinutes: 45,
		})
		expect(task.status).toBe("done")
		expect(task.kind).toBe("cloud")
		expect(task.cloudId).toBe("t_1")
		expect(task.minutes).toBe(4)
		expect(task.summary).toBe("Сделано")
		expect(task.changedFiles).toEqual(["src/x.ts"])
		expect(task.progress).toContain("terminal: Run the suite first")
		expect(await manager.diff(task.id)).toContain("+++ b/src/x.ts")

		await manager.apply(task.id)
		expect(task.status).toBe("applied")
		expect(git.calls.some((c) => c.startsWith("apply-patch:"))).toBe(true)
		expect(git.calls).not.toContain("remove-worktree")
	})

	it("refuses when the plan has no cloud agents or the tree is dirty, without a worktree", async () => {
		const { manager, cloud } = make()
		cloud.cloudAgents = false
		cloud.plan = "free"
		const task = manager.enqueueCloud({ title: "X", prompt: "x", repoPath: "/repo" })
		await flush(6)
		expect(task.status).toBe("failed")
		expect(task.error).toContain("Pro")

		const dirtyGit = new FakeGit()
		dirtyGit.dirty = true
		const second = make(dirtyGit)
		const t2 = second.manager.enqueueCloud({ title: "Y", prompt: "y", repoPath: "/repo" })
		await flush(6)
		expect(t2.status).toBe("failed")
		expect(t2.error).toContain("незакоммиченные")
		expect(second.cloud.created).toHaveLength(0)
	})

	it("does not count cloud tasks against the local concurrency limit", async () => {
		const { manager } = make()
		manager.enqueueCloud({ title: "C", prompt: "c", repoPath: "/repo" })
		const local = manager.enqueue({ title: "L", prompt: "l", repoPath: "/repo" })
		await flush(6)
		expect(local.status).toBe("running")
	})
})
