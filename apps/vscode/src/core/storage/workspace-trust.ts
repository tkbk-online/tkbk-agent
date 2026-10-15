/**
 * Workspace trust state shared with host-agnostic storage code.
 *
 * VS Code opens unfamiliar folders in Restricted Mode. The extension declares
 * `capabilities.untrustedWorkspaces: "limited"` so the agent stays usable
 * there, but anything the open folder can inject into the agent — hook
 * scripts under `.tkbk/hooks`, `.cline/hooks`, `.clinerules/hooks` — must not
 * run until the person trusts the folder. The VS Code entry point mirrors
 * `vscode.workspace.isTrusted` here (and flips it on
 * `onDidGrantWorkspaceTrust`); hosts without a trust concept (CLI, tests)
 * keep the default of `true`.
 */
let workspaceTrusted = true

export function setWorkspaceTrusted(trusted: boolean): void {
	workspaceTrusted = trusted
}

export function isWorkspaceTrusted(): boolean {
	return workspaceTrusted
}
