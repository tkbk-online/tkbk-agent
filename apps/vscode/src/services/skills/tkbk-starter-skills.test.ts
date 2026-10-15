import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installStarterSkills } from "./tkbk-starter-skills"

describe("installStarterSkills", () => {
	let root: string
	let source: string
	let target: string

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "tkbk-starter-skills-"))
		source = path.join(root, "bundle")
		target = path.join(root, "home", ".tkbk", "skills")
		await mkdir(path.join(source, "tkbk-amocrm"), { recursive: true })
		await writeFile(path.join(source, "tkbk-amocrm", "SKILL.md"), "---\nname: tkbk-amocrm\ndescription: amo\n---\nbody\n")
		await mkdir(path.join(source, "tkbk-bitrix24", "scripts"), { recursive: true })
		await writeFile(path.join(source, "tkbk-bitrix24", "SKILL.md"), "---\nname: tkbk-bitrix24\ndescription: b24\n---\nbody\n")
		await writeFile(path.join(source, "tkbk-bitrix24", "scripts", "helper.md"), "helper")
		// Not a skill: no SKILL.md inside.
		await mkdir(path.join(source, "notes"), { recursive: true })
		await writeFile(path.join(source, "README.md"), "not a skill dir")
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it("copies every bundled skill directory (with nested files) into a fresh target", async () => {
		const result = await installStarterSkills(source, target)

		expect(result.installed).toEqual(["tkbk-amocrm", "tkbk-bitrix24"])
		expect(result.skipped).toEqual([])
		expect(await readFile(path.join(target, "tkbk-amocrm", "SKILL.md"), "utf8")).toContain("name: tkbk-amocrm")
		expect(await readFile(path.join(target, "tkbk-bitrix24", "scripts", "helper.md"), "utf8")).toBe("helper")
	})

	it("never overwrites a skill the user already has", async () => {
		await mkdir(path.join(target, "tkbk-amocrm"), { recursive: true })
		await writeFile(path.join(target, "tkbk-amocrm", "SKILL.md"), "user edited")

		const result = await installStarterSkills(source, target)

		expect(result.installed).toEqual(["tkbk-bitrix24"])
		expect(result.skipped).toEqual(["tkbk-amocrm"])
		expect(await readFile(path.join(target, "tkbk-amocrm", "SKILL.md"), "utf8")).toBe("user edited")
	})

	it("is a no-op when the bundle directory is missing", async () => {
		const result = await installStarterSkills(path.join(root, "missing"), target)

		expect(result).toEqual({ installed: [], skipped: [] })
	})

	it("is idempotent across activations", async () => {
		await installStarterSkills(source, target)
		const second = await installStarterSkills(source, target)

		expect(second.installed).toEqual([])
		expect(second.skipped).toEqual(["tkbk-amocrm", "tkbk-bitrix24"])
	})
})
