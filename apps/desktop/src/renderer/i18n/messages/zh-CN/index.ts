import type { CatalogFor } from '../../types'
import type { Messages } from '../en'
import { a11y } from './a11y'
import { app } from './app'
import { chat } from './chat'
import { context } from './context'
import { errors } from './errors'
import { grid } from './grid'
import { keyboard } from './keyboard'
import { panel } from './panel'
import { settings } from './settings'
import { sidebar } from './sidebar'
import { views } from './views'

/**
 * The zh-CN catalog. Every domain file is already checked against its English
 * counterpart; the annotation here is the backstop that catches a domain file
 * someone forgot to merge in.
 */
export const zhCN: CatalogFor<Messages> = {
  ...app,
  ...sidebar,
  ...settings,
  ...panel,
  ...grid,
  ...keyboard,
  ...views,
  ...a11y,
  ...context,
  ...chat,
  ...errors,
}
