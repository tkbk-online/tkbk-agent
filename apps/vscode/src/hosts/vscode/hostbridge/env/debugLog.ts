import { Empty, StringRequest } from "@shared/proto/cline/common"
import * as vscode from "vscode"

const CLINE_OUTPUT_CHANNEL = vscode.window.createOutputChannel("TKBK Agent")

// Appends a log message to the TKBK Agent output channel.
export async function debugLog(request: StringRequest): Promise<Empty> {
	CLINE_OUTPUT_CHANNEL.appendLine(request.value)
	return Empty.create({})
}

// Register the TKBK Agent output channel within the VSCode extension context.
export function registerClineOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
	context.subscriptions.push(CLINE_OUTPUT_CHANNEL)
	return CLINE_OUTPUT_CHANNEL
}
