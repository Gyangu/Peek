/**
 * read_workspace —— 只读工具：让 AI "看见"当前界面。
 *
 * 直接读 main 的 Workspace 真源快照（零 renderer 往返，PLAN 第 3 节）。
 * 返回布局树 + 各视图摘要：每个 panel 的位置、视图类型、所连库、所看的表/查询、
 * 当前行数/是否加载中。**不含任何结果集数据本体**——那在界面里。
 */

import { z } from 'zod'
import { defineReadTool } from '../executor'
import { buildWorkspaceBrief, renderLayoutOutline, toJson, type BriefSection } from '../summary'

const SectionSchema = z.enum(['layout', 'views', 'connections', 'results'])

const InputSchema = z.object({
  /** 只取需要的部分，省 token；不给则全给 */
  include: z.array(SectionSchema).min(1).optional(),
  /** 附上原始布局树（含 split 的 id/dir/ratio，layout.setRatio 需要） */
  withLayoutTree: z.boolean().optional(),
})

export default defineReadTool({
  kind: 'read',
  name: 'read_workspace',
  title: '读取界面状态',
  description:
    '读取 peek 当前的界面状态：平铺布局树、每个面板里是什么视图、连的哪个库、' +
    '正在看哪张表或哪条查询、结果集的行数与加载状态，以及所有连接的能力集。' +
    '任何要改界面的操作之前都该先看一眼这个。返回不含结果集数据本体。' +
    '结果集状态里 paused 表示"背压把流停住了，不是查询失败"——' +
    '这种结果集的 rowsUsable 为 true，已加载的行可以直接用，重新执行即可继续取数；' +
    '只有 error 才是真失败（rowsUsable=false）。',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  read(input, ctx) {
    const snap = ctx.getSnapshot()
    const include: readonly BriefSection[] | undefined = input.include
    const brief = buildWorkspaceBrief(snap, include)

    const payload: Record<string, unknown> = {
      rev: brief.rev,
      focusedPanel: brief.focusedPanel,
    }
    const want = (s: BriefSection): boolean => include === undefined || include.includes(s)
    if (want('layout') || want('views')) payload['panels'] = brief.panels
    if (want('connections')) payload['connections'] = brief.connections
    if (want('results')) payload['results'] = brief.results
    if (input.withLayoutTree === true) payload['layout'] = brief.layout

    const outline = want('layout') ? `布局：\n${renderLayoutOutline(snap)}\n\n` : ''
    const connLine =
      brief.connections.length > 0
        ? `连接：${brief.connections.map((c) => `${c.label}(${c.connId}, ${c.driverId}, ${c.status})`).join('；')}\n\n`
        : '连接：无\n\n'

    return {
      text: `workspace rev=${brief.rev}\n\n${outline}${want('connections') ? connLine : ''}${toJson(payload)}`,
      data: payload,
    }
  },
})
