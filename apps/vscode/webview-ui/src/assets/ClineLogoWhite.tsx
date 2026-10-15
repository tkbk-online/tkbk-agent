import { SVGProps } from "react"

/**
 * TKBK monogram, white on transparent. Kept under the historical file name so
 * every Cline surface that imports the logo picks up the TKBK brand without a
 * rename across the webview.
 */
const ClineLogoWhite = (props: SVGProps<SVGSVGElement>) => (
	<svg fill="none" height="50" role="img" viewBox="0 0 36 36" width="50" xmlns="http://www.w3.org/2000/svg" {...props}>
		<title>TKBK</title>
		<path
			clipRule="evenodd"
			d="M5 0h26a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5zm1 10h12v4h-4v13h-4V14H6v-4zm14 0h4v6l4-6h5l-6 8 6 9h-5l-4-7v7h-4V10z"
			fill="white"
			fillRule="evenodd"
		/>
	</svg>
)
export default ClineLogoWhite
