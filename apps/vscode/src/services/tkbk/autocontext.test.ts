import { describe, expect, it } from "bun:test"
import path from "node:path"
import { formatAutocontext } from "./autocontext"

const cwd = path.resolve("/repo")
const abs = (p: string) => path.join(cwd, p)

describe("formatAutocontext", () => {
	it("renders active file, tabs, diagnostics (errors first) and git state with relative paths", () => {
		const text = formatAutocontext({
			cwd,
			activeFile: abs("src/a.ts"),
			openTabs: [abs("src/a.ts"), abs("src/b.ts"), "/elsewhere/x.md"],
			diagnostics: [
				{ file: abs("src/b.ts"), line: 7, severity: "warning", message: "unused var", source: "ts" },
				{ file: abs("src/a.ts"), line: 3, severity: "error", message: "Type 'x' is not\n  assignable" },
			],
			branch: "main",
			gitStatus: " M src/a.ts\n?? notes.md",
			gitDiffStat: " src/a.ts | 2 +-\n 1 file changed",
		})
		expect(text.startsWith("# Текущий контекст редактора")).toBe(true)
		expect(text).toContain("Активный файл: src/a.ts")
		expect(text).toContain("Открытые вкладки: src/b.ts, /elsewhere/x.md")
		const errorIdx = text.indexOf("ошибка src/a.ts:3 — Type 'x' is not assignable")
		const warnIdx = text.indexOf("предупреждение src/b.ts:7 [ts] — unused var")
		expect(errorIdx).toBeGreaterThan(-1)
		expect(warnIdx).toBeGreaterThan(errorIdx)
		expect(text).toContain("ошибок: 1, предупреждений: 1")
		expect(text).toContain("Ветка: main")
		expect(text).toContain("?? notes.md")
		expect(text).toContain("1 file changed")
	})

	it("caps long lists", () => {
		const text = formatAutocontext({
			cwd,
			openTabs: Array.from({ length: 20 }, (_, i) => abs(`f${i}.ts`)),
			diagnostics: Array.from({ length: 25 }, (_, i) => ({
				file: abs("x.ts"),
				line: i + 1,
				severity: "error" as const,
				message: `e${i}`,
			})),
		})
		expect(text).toContain("… ещё 5")
		expect(text.split("\n").filter((l) => l.startsWith("- ошибка")).length).toBe(20)
	})

	it("is empty when there is nothing to say", () => {
		expect(formatAutocontext({ cwd, openTabs: [], diagnostics: [] })).toBe("")
	})
})
