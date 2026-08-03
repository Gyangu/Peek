import { ERROR_MESSAGES } from '@peek/core'
import { a11y } from './a11y'
import { app } from './app'
import { chat } from './chat'
import { context } from './context'
import { grid } from './grid'
import { keyboard } from './keyboard'
import { menu } from './menu'
import { panel } from './panel'
import { settings } from './settings'
import { sidebar } from './sidebar'
import { views } from './views'

/**
 * The English catalog, and therefore the shape of every other catalog.
 *
 * `error.*` comes straight from `@peek/core` rather than being restated here:
 * main already needs those English strings to fill `PeekError.message`, and one
 * copy cannot drift from itself. Everything else is UI-only and lives in the
 * domain files next door.
 *
 * Domain files exist so that parallel work does not collide — add your keys to
 * the file that matches the surface you are translating, never to this one.
 */
export const en = {
  ...app,
  ...sidebar,
  ...settings,
  ...panel,
  ...grid,
  ...keyboard,
  ...menu,
  ...views,
  ...a11y,
  ...context,
  ...chat,
  ...ERROR_MESSAGES,
} as const

export type Messages = typeof en
