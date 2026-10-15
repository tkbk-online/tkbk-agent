import { openAiModelInfoSafeDefaults } from "@shared/api"
import type { Mode } from "@shared/storage/types"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useProviderModelSelection } from "@/hooks/useProviderModelSelection"
import { useProviderModels } from "@/hooks/useProviderModels"
import { UiServiceClient } from "@/services/grpc-client"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { useProviderApiKeyField } from "../utils/useProviderApiKeyField"
import { type ModelPickerSelection, ModelPickerWithManualEntry } from "./ModelPickerWithManualEntry"
import { TkbkLicensePanel } from "./TkbkLicensePanel"

export const TKBK_PROVIDER_ID = "tkbk"
export const TKBK_LOGIN_URL = "https://tkbk.online/login"
export const TKBK_BUY_URL = "https://tkbk.online/buy"
export const TKBK_DASHBOARD_URL = "https://tkbk.online/dashboard"
export const TKBK_DOCS_URL = "https://tkbk.online/docs"

/**
 * Props for the TkbkProvider component
 */
interface TkbkProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

function openExternal(url: string) {
	UiServiceClient.openUrl({ value: url }).catch((err) => console.error(`Failed to open ${url}:`, err))
}

/**
 * Settings for the TKBK gateway (https://tkbk.online): one `cr_…` key for
 * Claude, GPT, DeepSeek, GLM and Grok. The key is stored in the SDK provider
 * config (providers.json); the model list comes from the bundled TKBK catalog
 * plus the gateway's `GET /v1/models` once a key is saved.
 */
export const TkbkProvider = ({ showModelOptions, isPopup, currentMode }: TkbkProviderProps) => {
	const { models, defaultModelId, isLoading, isStale, error } = useProviderModels(TKBK_PROVIDER_ID)
	const { config, write, commitSelection } = useProviderConfig(TKBK_PROVIDER_ID)
	const { selectedModel, commitModelSelection } = useProviderModelSelection(TKBK_PROVIDER_ID, currentMode, {
		models,
		defaultModelId,
		config,
		commitSelection,
	})
	const { savedApiKeyMask, handleApiKeyChange } = useProviderApiKeyField({
		apiKeyLength: config?.apiKeyLength,
		providerName: "TKBK",
		write,
	})
	const hasKey = (config?.apiKeyLength ?? 0) > 0

	const handleModelSelect = (selection: ModelPickerSelection) => {
		void commitModelSelection(selection).catch((err) => console.error("Failed to commit TKBK model selection:", err))
	}

	const selectedModelInfo = selectedModel.modelInfo ?? openAiModelInfoSafeDefaults

	return (
		<div>
			<ApiKeyField
				helpText="Ключ хранится только на этом компьютере и используется для запросов к api.tkbk.online."
				initialValue={savedApiKeyMask}
				label="Ключ TKBK"
				onChange={handleApiKeyChange}
				placeholder="cr_…"
				providerName="TKBK"
			/>

			<div className="flex flex-wrap gap-2 mt-1 mb-2">
				<VSCodeButton appearance={hasKey ? "secondary" : "primary"} onClick={() => openExternal(TKBK_LOGIN_URL)}>
					Войти через Telegram-бота
				</VSCodeButton>
				<VSCodeButton appearance="secondary" onClick={() => openExternal(TKBK_BUY_URL)}>
					Купить ключ
				</VSCodeButton>
			</div>

			<p className="text-xs text-(--vscode-descriptionForeground) mt-0 mb-3">
				{hasKey ? (
					<>
						Ключ сохранён. Баланс и расход — в{" "}
						<VSCodeLink className="inline text-xs" href={TKBK_DASHBOARD_URL}>
							кабинете TKBK
						</VSCodeLink>
						.
					</>
				) : (
					<>
						Нажмите «Войти через Telegram-бота», подтвердите вход в боте, скопируйте ключ <code>cr_…</code> из
						кабинета и вставьте его в поле выше. Нет ключа — «Купить ключ»: оплата в рублях, ключ приходит сразу.{" "}
						<VSCodeLink className="inline text-xs" href={TKBK_DOCS_URL}>
							Документация
						</VSCodeLink>
					</>
				)}
			</p>

			{hasKey && <TkbkLicensePanel />}

			{showModelOptions && (
				<>
					<ModelPickerWithManualEntry
						allowsCustomIds={true}
						error={error}
						isLoading={isLoading}
						isStale={isStale}
						models={models}
						onSelect={handleModelSelect}
						selectedModel={selectedModel}
					/>

					{selectedModelInfo.supportsReasoning === true && (
						<ReasoningEffortSelector
							currentMode={currentMode}
							onEffortChange={(effort) => {
								void write({
									reasoning: {
										enabled: effort !== "none",
										effort: effort !== "none" ? effort : undefined,
									},
								}).catch((err) => console.error("Failed to update TKBK reasoning effort:", err))
							}}
						/>
					)}

					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModel.modelId} />

					<p className="text-xs text-(--vscode-descriptionForeground) mt-2">
						Цены показаны в долларах объёма — так же, как списывается баланс в кабинете TKBK.
					</p>
				</>
			)}
		</div>
	)
}
