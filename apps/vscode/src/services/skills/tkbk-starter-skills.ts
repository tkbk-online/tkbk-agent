import { access, cp, mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"

export interface StarterSkillsInstallResult {
	/** Skill directories copied on this run. */
	installed: string[]
	/** Skill directories that already existed in the target and were left untouched. */
	skipped: string[]
	/** Premium skills (`tkbk-premium: true` in SKILL.md) held back because the plan does not allow them. */
	locked: string[]
}

export interface StarterSkillsInstallOptions {
	/** the TKBK plan allows premium skills (Pro and up) */
	premium?: boolean
}

/** `tkbk-premium: true` in the SKILL.md frontmatter marks a skill that needs the Pro plan. */
export async function isPremiumSkill(skillFile: string): Promise<boolean> {
	try {
		const text = await readFile(skillFile, "utf8")
		const head = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : ""
		return /^\s*tkbk-premium:\s*true\s*$/m.test(head)
	} catch {
		return false
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

/**
 * Seed the bundled TKBK starter skills (`<extension>/skills/<name>/SKILL.md`)
 * into the user's global TKBK skills directory (`~/.tkbk/skills`).
 *
 * Idempotent and conservative: a skill directory that already exists in the
 * target is never overwritten, so people can edit or delete the starters and
 * the extension will not put its copy back on the next activation. A missing
 * source directory (e.g. a dev host without the bundle) is not an error.
 */
export async function installStarterSkills(
	sourceDir: string,
	targetDir: string,
	options: StarterSkillsInstallOptions = {},
): Promise<StarterSkillsInstallResult> {
	const result: StarterSkillsInstallResult = { installed: [], skipped: [], locked: [] }

	let entries: Awaited<ReturnType<typeof readdir>>
	try {
		entries = await readdir(sourceDir, { withFileTypes: true })
	} catch {
		return result
	}

	const skillDirs = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b))
	if (skillDirs.length === 0) {
		return result
	}

	await mkdir(targetDir, { recursive: true })

	for (const name of skillDirs) {
		const source = path.join(sourceDir, name)
		if (!(await exists(path.join(source, "SKILL.md")))) {
			continue
		}
		const destination = path.join(targetDir, name)
		if (await exists(destination)) {
			result.skipped.push(name)
			continue
		}
		if (!options.premium && (await isPremiumSkill(path.join(source, "SKILL.md")))) {
			result.locked.push(name)
			continue
		}
		await cp(source, destination, { recursive: true })
		result.installed.push(name)
	}

	return result
}
