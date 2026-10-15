import { access, cp, mkdir, readdir } from "node:fs/promises"
import path from "node:path"

export interface StarterSkillsInstallResult {
	/** Skill directories copied on this run. */
	installed: string[]
	/** Skill directories that already existed in the target and were left untouched. */
	skipped: string[]
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
export async function installStarterSkills(sourceDir: string, targetDir: string): Promise<StarterSkillsInstallResult> {
	const result: StarterSkillsInstallResult = { installed: [], skipped: [] }

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
		await cp(source, destination, { recursive: true })
		result.installed.push(name)
	}

	return result
}
