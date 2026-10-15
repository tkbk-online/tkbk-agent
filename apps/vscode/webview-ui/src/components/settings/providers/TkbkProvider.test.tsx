import type { ProviderConfigResponse } from "@shared/proto/cline/models"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChangeEventHandler, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useProviderModels } from "@/hooks/useProviderModels"
import { UiServiceClient } from "@/services/grpc-client"
import { TKBK_BUY_URL, TKBK_LOGIN_URL, TkbkProvider } from "./TkbkProvider"

const providerConfig = (config: Partial<ProviderConfigResponse>): ProviderConfigResponse => config as ProviderConfigResponse

vi.mock("@/hooks/useProviderModels", () => ({
	useProviderModels: vi.fn(),
}))

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	UiServiceClient: {
		openUrl: vi.fn(async () => ({})),
	},
	ModelsServiceClient: {},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: {}, planActSeparateModelsSetting: false }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()
	return {
		...actual,
		VSCodeButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
			<button onClick={onClick} type="button">
				{children}
			</button>
		),
		VSCodeDropdown: ({
			children,
			id,
			onChange,
			value,
			"aria-label": ariaLabel,
		}: {
			children?: ReactNode
			id?: string
			onChange?: ChangeEventHandler<HTMLSelectElement>
			value?: string
			"aria-label"?: string
		}) => (
			<select aria-label={ariaLabel} id={id} onChange={onChange} value={value}>
				{children}
			</select>
		),
		VSCodeOption: ({ children, value }: { children?: ReactNode; value?: string }) => (
			<option value={value}>{children}</option>
		),
	}
})

const TKBK_MODELS = {
	"claude-sonnet-5": {
		name: "Claude Sonnet 5",
		supportsPromptCache: true,
		contextWindow: 200_000,
		supportsReasoning: true,
	},
	"gpt-6.1-sol": { name: "GPT-6.1 Sol", supportsPromptCache: true, contextWindow: 400_000 },
}

function mockHooks(config: Partial<ProviderConfigResponse> | undefined) {
	const commitSelection = vi.fn(async () => undefined)
	const write = vi.fn(async () => undefined)
	vi.mocked(useProviderModels).mockReturnValue({
		models: TKBK_MODELS,
		defaultModelId: "claude-sonnet-5",
		isLoading: false,
		isStale: false,
		error: undefined,
		refresh: vi.fn(),
		fingerprint: "fingerprint",
	})
	vi.mocked(useProviderConfig).mockReturnValue({
		config: config ? providerConfig(config) : undefined,
		write,
		commitSelection,
	})
	return { commitSelection, write }
}

describe("TkbkProvider", () => {
	it("offers the Telegram bot login and the key purchase page before a key is saved", () => {
		mockHooks(undefined)
		render(<TkbkProvider currentMode="act" showModelOptions={true} />)

		fireEvent.click(screen.getByRole("button", { name: "Войти через Telegram-бота" }))
		expect(UiServiceClient.openUrl).toHaveBeenCalledWith({ value: TKBK_LOGIN_URL })

		fireEvent.click(screen.getByRole("button", { name: "Купить ключ" }))
		expect(UiServiceClient.openUrl).toHaveBeenCalledWith({ value: TKBK_BUY_URL })

		expect(screen.getByText(/вставьте его в поле выше/)).toBeTruthy()
	})

	it("saves the cr_ key to the SDK provider config", async () => {
		const { write } = mockHooks(undefined)
		render(<TkbkProvider currentMode="act" showModelOptions={false} />)

		const input = screen.getByPlaceholderText("cr_…")
		fireEvent.input(input, { target: { value: "cr_test_key_123" } })

		await waitFor(() => expect(write).toHaveBeenCalledWith({ apiKey: "cr_test_key_123" }))
	})

	it("shows the saved-key state and commits model selections for the tkbk provider", async () => {
		const { commitSelection } = mockHooks({ apiKeyLength: 32 })
		render(<TkbkProvider currentMode="plan" showModelOptions={true} />)

		expect(screen.getByText(/Ключ сохранён/)).toBeTruthy()

		expect(screen.getByLabelText("Модель")).toHaveValue("claude-sonnet-5")
		fireEvent.change(screen.getByLabelText("Модель"), { target: { value: "gpt-6.1-sol" } })

		await waitFor(() =>
			expect(commitSelection).toHaveBeenCalledWith("plan", {
				providerId: "tkbk",
				modelId: "gpt-6.1-sol",
			}),
		)
	})
})
