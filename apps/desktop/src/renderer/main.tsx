import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { startRenderer } from './state/sync'
import './styles.css'

/**
 * renderer 入口。
 *
 * 接线（patch 订阅、MessagePort 接收）在 React 之外完成，
 * 保证 StrictMode 的双跑 effect 不会造成重复订阅。
 */
startRenderer()

const root = document.getElementById('root')
if (!root) throw new Error('找不到挂载点 #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
