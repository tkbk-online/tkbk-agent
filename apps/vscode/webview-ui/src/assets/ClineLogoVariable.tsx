import { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { getEnvironmentColor } from "../utils/environmentColors"

/**
 * TKBK monogram that follows the VS Code theme and, in non-production
 * environments, the environment indicator colour. Kept under the historical
 * Cline file name so existing imports keep working.
 *
 * - Local: yellow/orange (development/experimental)
 * - Staging: blue (stable testing)
 * - Production: default icon colour
 */
const ClineLogoVariable = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const { environment, ...svgProps } = props
	const fillColor = environment ? getEnvironmentColor(environment) : "var(--vscode-icon-foreground)"

	return (
		<svg fill="none" height="50" role="img" viewBox="0 0 36 36" width="50" xmlns="http://www.w3.org/2000/svg" {...svgProps}>
			<title>TKBK</title>
			<path
				clipRule="evenodd"
				d="M5 0h26a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5zm1 10h12v4h-4v13h-4V14H6v-4zm14 0h4v6l4-6h5l-6 8 6 9h-5l-4-7v7h-4V10z"
				fill={fillColor}
				fillRule="evenodd"
			/>
		</svg>
	)
}
export default ClineLogoVariable
