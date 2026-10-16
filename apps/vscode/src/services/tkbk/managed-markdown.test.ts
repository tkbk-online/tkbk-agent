import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installManagedMarkdown, renderManagedMarkdown } from "./managed-markdown"

const EXPLORE_TEMPLATE = `---
name: explore
description: Разведка.
tools: read_files, search_codebase
tkbk-managed: true
{{MODEL_LINE}}
---

Ты — разведчик.
`

const REVIEW_TEMPLATE = `---
name: review
description: Ревью.
tkbk-managed: true
---

Ты — ревьюер.
`

describe("renderManagedMarkdown", () => {
	it("writes a modelId line for the fast model", () => {
		const rendered = renderManagedMarkdown(EXPLORE_TEMPLATE, { fastModelId: "glm-5.3" })
		expect(rendered).toContain("\nmodelId: glm-5.3\n---")
		expect(rendered).not.toContain("{{MODEL_LINE}}")
	})

	it("drops the placeholder line entirely when no fast model applies", () => {
		const rendered = renderManagedMarkdown(EXPLORE_TEMPLATE, {})
		expect(rendered).not.toContain("modelId")
		expect(rendered).not.toContain("{{MODEL_LINE}}")
		expect(rendered).toContain("tkbk-managed: true\n---")
	})
})

describe("installManagedMarkdown", () => {
	let root: string
	let source: string
	let target: string

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "tkbk-starter-agents-"))
		source = path.join(root, "bundle")
		target = path.join(root, "home", ".tkbk", "agents")
		await mkdir(source, { recursive: true })
		await writeFile(path.join(source, "explore.md"), EXPLORE_TEMPLATE)
		await writeFile(path.join(source, "review.md"), REVIEW_TEMPLATE)
		await writeFile(path.join(source, "notes.txt"), "ignored")
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it("installs every bundled role rendered with the fast model", async () => {
		const result = await installManagedMarkdown(source, target, { fastModelId: "glm-5.3" })

		expect(result.installed).toEqual(["explore.md", "review.md"])
		expect(result.updated).toEqual([])
		expect(await readFile(path.join(target, "explore.md"), "utf8")).toContain("modelId: glm-5.3")
		expect(await readFile(path.join(target, "review.md"), "utf8")).toContain("name: review")
	})

	it("re-renders managed files when the routing changes and nothing otherwise", async () => {
		await installManagedMarkdown(source, target, { fastModelId: "glm-5.3" })
		const unchanged = await installManagedMarkdown(source, target, { fastModelId: "glm-5.3" })
		expect(unchanged).toEqual({ installed: [], updated: [], skipped: [] })

		const rerouted = await installManagedMarkdown(source, target, {})
		expect(rerouted.updated).toEqual(["explore.md"])
		expect(await readFile(path.join(target, "explore.md"), "utf8")).not.toContain("modelId")
	})

	it("never touches a file the person took over", async () => {
		await mkdir(target, { recursive: true })
		await writeFile(path.join(target, "explore.md"), "---\nname: explore\ndescription: mine\n---\nMy own prompt.\n")

		const result = await installManagedMarkdown(source, target, { fastModelId: "glm-5.3" })

		expect(result.skipped).toEqual(["explore.md"])
		expect(result.installed).toEqual(["review.md"])
		expect(await readFile(path.join(target, "explore.md"), "utf8")).toContain("My own prompt.")
	})

	it("is a no-op without a bundle directory", async () => {
		expect(await installManagedMarkdown(path.join(root, "missing"), target)).toEqual({
			installed: [],
			updated: [],
			skipped: [],
		})
	})
})
