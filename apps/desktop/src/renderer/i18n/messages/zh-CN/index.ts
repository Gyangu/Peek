import type { CatalogFor } from '../../types'
import type { Messages } from '../en'
import { app } from './app'
import { errors } from './errors'
import { grid } from './grid'
import { panel } from './panel'
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
  ...panel,
  ...grid,
  ...views,
  ...errors,
}
