#!/usr/bin/env bun
/**
 * Live negative checks that need no model tokens:
 *  - license: the real check URL (404 until the site ships it) must degrade to Free quietly
 *  - cloud: the real orchestrator URL (not deployed yet) must fail with a Russian message
 *   TKBK_API_KEY=cr_… bun scripts/tkbk-live/license-cloud-live.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	type BackgroundGitOps,
	BackgroundTaskManager,
	type BackgroundTaskRunner,
} from "../../src/services/tkbk/background/background-tasks"
import { TkbkCloudAgents } from "../../src/services/tkbk/cloud/tkbkCloudAgents"
import { TkbkLicenseService } from "../../src/services/tkbk/license/TkbkLicenseService"

const apiKey = process.env.TKBK_API_KEY?.trim() ?? ""
if (!apiKey) {
	console.error("TKBK_API_KEY is not set")
	process.exit(1)
}

// --- license
const dir = mkdtempSync(path.join(os.tmpdir(), "tkbk-license-live-"))
try {
	const service = new TkbkLicenseService({
		dir,
		version: "0.1.0-live",
		getApiKey: () => apiKey,
		onChange: () => undefined,
		log: (m) => console.log("  log:", m.replace(/cr_[A-Za-z0-9_-]{8,}/g, "cr_***")),
	})
	await service.load()
	const t0 = performance.now()
	const view = await service.refresh(true)
	console.log(
		`license: ${Math.round(performance.now() - t0)} ms → status=${view.status} plan=${view.plan} message="${view.message}" features=${JSON.stringify(view.features)}`,
	)
	console.log("  cloud_agents unlocked:", service.isUnlocked("cloud_agents"), "| throws:", "no")
} catch (error) {
	console.log("license: THREW", error instanceof Error ? error.message : String(error))
} finally {
	rmSync(dir, { recursive: true, force: true })
}

// --- cloud
const git: BackgroundGitOps = {
	currentBranch: async () => "main",
	createWorktree: async () => undefined,
	commitAll: async () => false,
	changedFiles: async () => [],
	diff: async () => "",
	applyBranch: async () => undefined,
	removeWorktree: async () => undefined,
	deleteBranch: async () => undefined,
	remoteUrl: async () => "https://github.com/tkbk-online/tkbk-agent",
	isDirty: async () => false,
	applyPatch: async () => undefined,
}
const runner: BackgroundTaskRunner = { run: async () => "" }
const serverUrl = process.env.TKBK_CLOUD_URL ?? "https://agents.tkbk.online"
const manager = new BackgroundTaskManager({
	git,
	runner,
	maxConcurrent: () => 1,
	cloud: () => new TkbkCloudAgents({ baseUrl: serverUrl, apiKey, timeoutMs: 10_000 }),
	cloudSettings: () => ({ serverUrl, model: "", maxMinutes: 30 }),
})
const task = manager.enqueueCloud({ title: "проверка", prompt: "ничего не делать", repoPath: process.cwd() })
await new Promise<void>((resolve) => {
	const check = () => (task.status === "failed" || task.status === "done" ? resolve() : setTimeout(check, 200))
	check()
})
console.log(`cloud: status=${task.status}`)
console.log(`  error: ${task.error?.replace(/cr_[A-Za-z0-9_-]{8,}/g, "cr_***")}`)
process.exit(0)
