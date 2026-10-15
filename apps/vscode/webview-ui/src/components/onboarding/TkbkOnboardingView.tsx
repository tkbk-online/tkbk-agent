import { BooleanRequest } from "@shared/proto/cline/common"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { LoaderCircleIcon } from "lucide-react"
import { useCallback, useState } from "react"
import ClineLogoWhite from "@/assets/ClineLogoWhite"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useProviderModels } from "@/hooks/useProviderModels"
import { StateServiceClient } from "@/services/grpc-client"
import { TKBK_PROVIDER_ID, TkbkProvider } from "../settings/providers/TkbkProvider"
import ApiConfigurationSection from "../settings/sections/ApiConfigurationSection"
import { useApiConfigurationHandlers } from "../settings/utils/useApiConfigurationHandlers"

const FALLBACK_MODEL_ID = "claude-sonnet-5"

/**
 * First-run screen of TKBK Agent. The default path is the TKBK gateway: sign in
 * through the Telegram bot, paste the `cr_…` key, pick a model, start. "Другой
 * провайдер" reveals the regular provider picker for people who bring their own
 * OpenAI / Anthropic / Gemini key.
 */
export const TkbkOnboardingView = () => {
	const { mode, setShowWelcome, hideAccount, hideSettings } = useExtensionState()
	const { handleFieldsChange } = useApiConfigurationHandlers()
	const { config, commitSelection } = useProviderConfig(TKBK_PROVIDER_ID)
	const { defaultModelId } = useProviderModels(TKBK_PROVIDER_ID)
	const [useOtherProvider, setUseOtherProvider] = useState(false)
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)

	const hasKey = (config?.apiKeyLength ?? 0) > 0
	const canStart = !isSaving && (useOtherProvider || hasKey)

	const finish = useCallback(async () => {
		setIsSaving(true)
		setError(undefined)
		try {
			if (!useOtherProvider) {
				const modelId =
					(mode === "plan" ? config?.planSelection?.modelId : config?.actSelection?.modelId) ||
					config?.actSelection?.modelId ||
					config?.planSelection?.modelId ||
					defaultModelId ||
					FALLBACK_MODEL_ID
				await Promise.all([
					commitSelection("plan", { providerId: TKBK_PROVIDER_ID, modelId }),
					commitSelection("act", { providerId: TKBK_PROVIDER_ID, modelId }),
				])
				await handleFieldsChange({
					planModeApiProvider: TKBK_PROVIDER_ID,
					actModeApiProvider: TKBK_PROVIDER_ID,
					planModeApiModelId: modelId,
					actModeApiModelId: modelId,
				})
			}
			await StateServiceClient.setWelcomeViewCompleted(BooleanRequest.create({ value: true }))
			setShowWelcome(false)
			hideAccount()
			hideSettings()
		} catch (err) {
			console.error("Failed to finish TKBK onboarding:", err)
			setError("Не удалось сохранить настройки. Попробуйте ещё раз.")
		} finally {
			setIsSaving(false)
		}
	}, [
		useOtherProvider,
		mode,
		config,
		defaultModelId,
		commitSelection,
		handleFieldsChange,
		setShowWelcome,
		hideAccount,
		hideSettings,
	])

	return (
		<div className="fixed inset-0 p-0 flex flex-col w-full">
			<div className="h-full px-5 xs:mx-10 overflow-auto flex flex-col gap-4 items-center justify-center">
				<ClineLogoWhite className="size-16 flex-shrink-0" />
				<h2 className="text-lg font-semibold p-0 m-0 flex-shrink-0">TKBK Agent</h2>
				<p className="text-foreground text-sm text-center m-0 p-0 flex-shrink-0 max-w-lg">
					Агент для кода прямо в редакторе: пишет и правит файлы, запускает команды, ходит в браузер — с вашего
					подтверждения. Claude, GPT, DeepSeek, GLM и Grok по одному ключу TKBK, оплата в рублях.
				</p>

				<div className="flex-1 w-full flex flex-col max-w-lg overflow-y-auto min-h-0 gap-3">
					{useOtherProvider ? <ApiConfigurationSection /> : <TkbkProvider currentMode={mode} showModelOptions={true} />}
				</div>

				<footer className="flex w-full max-w-lg flex-col gap-3 my-2 px-2 overflow-hidden flex-shrink-0">
					{error && <p className="text-error text-sm m-0 text-center">{error}</p>}
					<Button
						className={`w-full rounded-xs ${isSaving ? "animate-pulse" : ""}`}
						disabled={!canStart}
						onClick={finish}>
						{isSaving && <LoaderCircleIcon className="mr-2 size-4 animate-spin" />}
						Начать
					</Button>
					<div className="items-center justify-center flex text-sm text-foreground/80 gap-2 mb-3 text-pretty text-center">
						{useOtherProvider ? (
							<VSCodeLink className="inline" href="#" onClick={() => setUseOtherProvider(false)}>
								← Вернуться к ключу TKBK
							</VSCodeLink>
						) : (
							<VSCodeLink className="inline" href="#" onClick={() => setUseOtherProvider(true)}>
								Другой провайдер — свой ключ OpenAI, Anthropic, Gemini и других
							</VSCodeLink>
						)}
					</div>
					<div className="items-center justify-center flex text-xs text-foreground/60 text-center">
						Всё это можно поменять позже в настройках.
					</div>
				</footer>
			</div>
		</div>
	)
}

export default TkbkOnboardingView
