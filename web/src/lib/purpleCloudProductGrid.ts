import type { PurpleCloudProductRow } from './purpleCloudSizing'
import grid from './data/purpleCloudProductGrid.json'

/** Full PurpleCloud commercial grid (`npm run build:grid`: build-purplecloud-grid + expand-purplecloud-product-grid). */
export const PURPLE_CLOUD_PRODUCT_GRID = grid as PurpleCloudProductRow[]
