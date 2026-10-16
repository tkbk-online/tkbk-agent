import { mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import simpleGit from "simple-git"
import type { BackgroundGitOps } from "./background-tasks"

/**
 * simple-git implementation of the git operations background tasks need.
 * Everything runs against explicit paths: the repository for worktree and
 * branch management, the worktree for commits and diffs.
 */
export class SimpleGitOps implements BackgroundGitOps {
	async currentBranch(repoPath: string): Promise<string> {
		const git = simpleGit(repoPath)
		const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
		if (!branch || branch === "HEAD") {
			// Detached HEAD: pin the task to the commit instead of a branch name.
			return (await git.revparse(["HEAD"])).trim()
		}
		return branch
	}

	async createWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch: string): Promise<void> {
		await mkdir(path.dirname(worktreePath), { recursive: true })
		await simpleGit(repoPath).raw(["worktree", "add", "-b", branch, worktreePath, baseBranch])
	}

	async commitAll(worktreePath: string, message: string): Promise<boolean> {
		const git = simpleGit(worktreePath)
		await git.add(["-A"])
		const status = await git.status()
		if (status.staged.length === 0 && status.files.length === 0) {
			return false
		}
		await git.commit(message, undefined, { "--no-verify": null })
		return true
	}

	async changedFiles(worktreePath: string, baseBranch: string): Promise<string[]> {
		const out = await simpleGit(worktreePath).raw(["diff", "--name-only", `${baseBranch}...HEAD`])
		return out
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean)
	}

	async diff(worktreePath: string, baseBranch: string): Promise<string> {
		return simpleGit(worktreePath).raw(["diff", `${baseBranch}...HEAD`])
	}

	async applyBranch(repoPath: string, branch: string, baseBranch: string): Promise<void> {
		const git = simpleGit(repoPath)
		const patch = await git.raw(["diff", "--binary", `${baseBranch}...${branch}`])
		if (!patch.trim()) {
			return
		}
		const tmp = path.join(os.tmpdir(), `tkbk-apply-${Date.now()}.patch`)
		await writeFile(tmp, patch, "utf8")
		try {
			await git.raw(["apply", "--3way", "--index", tmp])
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(
				`Не удалось применить изменения без конфликтов: ${message}. Откройте worktree и перенесите правки вручную или сделайте merge ветки ${branch}.`,
			)
		} finally {
			await rm(tmp, { force: true })
		}
	}

	async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
		await simpleGit(repoPath).raw(["worktree", "remove", "--force", worktreePath])
	}

	async deleteBranch(repoPath: string, branch: string): Promise<void> {
		await simpleGit(repoPath).raw(["branch", "-D", branch])
	}
}
