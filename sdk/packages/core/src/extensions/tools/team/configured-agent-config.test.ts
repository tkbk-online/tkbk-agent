import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadConfiguredAgentConfigs,
	parseConfiguredAgentConfig,
} from "./configured-agent-config";

describe("configured agent config parser", () => {
	it("parses YAML frontmatter and system prompt body", () => {
		const config = parseConfiguredAgentConfig(`---
name: code-reviewer
description: Reviews code
tools: execute_command, read_file
skills:
  - review-pr
modelId: anthropic/claude-sonnet-4.6
---
You are a code reviewer.`);

		expect(config).toMatchObject({
			name: "code-reviewer",
			description: "Reviews code",
			tools: ["execute_command", "read_file"],
			skills: ["review-pr"],
			modelId: "anthropic/claude-sonnet-4.6",
			systemPrompt: "You are a code reviewer.",
		});
	});

	// Regression test for https://github.com/cline/cline/issues/12151: a leading UTF-8 BOM
	// (e.g. saved by Windows Notepad's "UTF-8 with BOM" encoding) must not prevent frontmatter
	// from being recognized.
	it("parses frontmatter when the content starts with a UTF-8 BOM", () => {
		const config = parseConfiguredAgentConfig(`\uFEFF---
name: code-reviewer
description: Reviews code
---
You are a code reviewer.`);

		expect(config).toMatchObject({
			name: "code-reviewer",
			description: "Reviews code",
			systemPrompt: "You are a code reviewer.",
		});
	});

	it("does not treat delimiter lines in the body as frontmatter delimiters", () => {
		const config = parseConfiguredAgentConfig(`---
name: code-reviewer
description: Reviews code
tools: read_file
---
Prompt body
---
More prompt`);

		expect(config.systemPrompt).toBe("Prompt body\n---\nMore prompt");
	});

	it.each([
		["empty", ""],
		["comment-only", "# comment"],
		["scalar", "code-reviewer"],
	])("rejects %s frontmatter candidates without hanging", (_name, yaml) => {
		expect(() =>
			parseConfiguredAgentConfig(`---
${yaml}
---
You are a code reviewer.`),
		).toThrow("Missing closing YAML frontmatter delimiter");
	});
});

describe("configured agent config loader", () => {
	it("loads Markdown and YAML agent files from a search path, ignoring other files", () => {
		const dir = mkdtempSync(join(tmpdir(), "tkbk-agent-configs-"));
		try {
			writeFileSync(
				join(dir, "explore.md"),
				[
					"---",
					"name: explore",
					"description: Разведка по коду",
					"tools: read_files, search_codebase",
					"modelId: deepseek-v4.1-flash",
					"tkbk-managed: true",
					"---",
					"",
					"Ты — разведчик.",
				].join("\n"),
				"utf8",
			);
			writeFileSync(
				join(dir, "tester.yaml"),
				["---", "name: tester", "description: Runs tests", "---", "You run tests."].join("\n"),
				"utf8",
			);
			writeFileSync(join(dir, "README.txt"), "not an agent", "utf8");

			const { configs, errors } = loadConfiguredAgentConfigs({ searchPaths: [dir] });

			expect(errors).toEqual([]);
			expect(configs.map((c) => c.name).sort()).toEqual(["explore", "tester"]);
			const explore = configs.find((c) => c.name === "explore");
			expect(explore?.modelId).toBe("deepseek-v4.1-flash");
			expect(explore?.tools).toEqual(["read_files", "search_codebase"]);
			expect(explore?.systemPrompt).toBe("Ты — разведчик.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
