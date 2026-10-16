import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export interface ManagedMarkdownOptions {
	/**
	 * Model the `explore` role should run on (cheap, fast). `undefined` leaves
	 * the role on the parent task's model — used when the active provider is
	 * not TKBK, where a TKBK model id would be unknown.
	 */
	fastModelId?: string
}

export interface ManagedMarkdownResult {
	/** Agent files written for the first time. */
	installed: string[]
	/** Managed agent files rewritten because their rendered content changed. */
	updated: string[]
	/** Files the person edited (no `tkbk-managed: true` marker) and therefore left alone. */
	skipped: string[]
}

const MODEL_LINE_PLACEHOLDER = "{{MODEL_LINE}}"
const MANAGED_MARKER = /^\s*tkbk-managed:\s*true\s*$/m

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

/** The frontmatter block of an agent file, or "" when there is none. */
function frontmatterOf(text: string): string {
	if (!text.startsWith("---")) {
		return ""
	}
	const end = text.indexOf("\n---", 3)
	return end === -1 ? "" : text.slice(3, end)
}

/**
 * Render a bundled agent template: the `{{MODEL_LINE}}` placeholder becomes
 * `modelId: <fast model>` or disappears (together with its line) when no fast
 * model applies.
 */
export function renderManagedMarkdown(template: string, options: ManagedMarkdownOptions): string {
	const modelLine = options.fastModelId?.trim() ? `modelId: ${options.fastModelId.trim()}` : ""
	return template
		.split("\n")
		.flatMap((line) => {
			if (!line.includes(MODEL_LINE_PLACEHOLDER)) {
				return [line]
			}
			const rendered = line.replace(MODEL_LINE_PLACEHOLDER, modelLine)
			return rendered.trim() ? [rendered] : []
		})
		.join("\n")
}

/**
 * Seed the bundled subagent roles (`<extension>/agents/*.md`) into the user's
 * global agents directory (`~/.tkbk/agents`), where the SDK's configured-agent
 * loader turns each file into a `subagent_<name>` tool.
 *
 * Files carrying `tkbk-managed: true` in their frontmatter are owned by the
 * extension and re-rendered whenever the template or the fast-model routing
 * changes. Remove that line to take a file over; it is then never touched.
 */
export async function installManagedMarkdown(
	sourceDir: string,
	targetDir: string,
	options: ManagedMarkdownOptions = {},
): Promise<ManagedMarkdownResult> {
	const result: ManagedMarkdownResult = { installed: [], updated: [], skipped: [] }

	let entries: string[]
	try {
		entries = (await readdir(sourceDir)).filter((name) => name.endsWith(".md")).sort((a, b) => a.localeCompare(b))
	} catch {
		return result
	}
	if (entries.length === 0) {
		return result
	}

	await mkdir(targetDir, { recursive: true })

	for (const name of entries) {
		const template = await readFile(path.join(sourceDir, name), "utf8")
		const rendered = renderManagedMarkdown(template, options)
		const destination = path.join(targetDir, name)

		if (!(await exists(destination))) {
			await writeFile(destination, rendered, "utf8")
			result.installed.push(name)
			continue
		}

		const current = await readFile(destination, "utf8")
		if (!MANAGED_MARKER.test(frontmatterOf(current))) {
			result.skipped.push(name)
			continue
		}
		if (current === rendered) {
			continue
		}
		await writeFile(destination, rendered, "utf8")
		result.updated.push(name)
	}

	return result
}
