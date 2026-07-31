import type { ReactElement } from 'react'
import type { PeekError } from '@peek/core'

/** 视图内错误条。错误一律是结构化 PeekError，直接摊开给用户看。 */
export function ViewError({ error }: { error: PeekError | undefined }): ReactElement | null {
  if (!error) return null
  return (
    <div className="view-error">
      <div>
        <strong>[{error.code}]</strong> {error.message}
        {error.driverCode ? <span style={{ opacity: 0.7 }}> · {error.driverCode}</span> : null}
        {error.position !== undefined ? (
          <span style={{ opacity: 0.7 }}> · 位置 {error.position}</span>
        ) : null}
      </div>
      {error.detail ? <div className="detail">{error.detail}</div> : null}
    </div>
  )
}
