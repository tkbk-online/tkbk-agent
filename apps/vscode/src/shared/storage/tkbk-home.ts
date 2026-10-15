import * as os from "node:os"
import path from "node:path"

/**
 * TKBK Agent's data home on this machine: `TKBK_DIR`, else `CLINE_DIR` (kept
 * for tooling written against the upstream name), else `~/.tkbk`.
 *
 * Mirrors `resolveClineDir` in @cline/shared. Every host-side reader of
 * globalState.json, secrets.json, providers.json, tasks and skills must go
 * through the same rules, otherwise state splits across directories — and a
 * machine that also runs Cline would start sharing its `~/.cline` history and
 * credentials with TKBK Agent.
 */
export function resolveTkbkHomeDir(): string {
	return process.env.TKBK_DIR?.trim() || process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".tkbk")
}
