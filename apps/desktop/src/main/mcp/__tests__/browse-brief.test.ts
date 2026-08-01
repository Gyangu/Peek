import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  asConnId,
  asPanelId,
  asViewId,
  collectionBrowseStyle,
  snapshotWorkspace,
  type CollectionRef,
  type TableViewState,
  type Workspace,
} from '@peek/core'
import { briefViews, renderPanelBrief } from '../summary'

/**
 * What `read_workspace` says about a collection's browse style.
 *
 * The renderer asks `collectionBrowseStyle` before it draws a sortable column
 * header, so a user never clicks a control the driver would refuse. The AI had no
 * equivalent: `view.update` with a sort on a Redis keyspace is a BAD_REQUEST, and
 * the only way to learn that was to send one and read the error. These tests pin
 * that the same answer now reaches the brief.
 */

const CONN = asConnId('c_1')
const PANEL = asPanelId('p_1')

function workspaceWith(ref: CollectionRef): Workspace {
  const view: TableViewState = {
    id: asViewId('v_1'),
    kind: 'table',
    connId: CONN,
    ref,
    page: { offset: 0, limit: 200 },
    status: 'ready',
  }
  return {
    rev: 1,
    connections: {},
    layout: { type: 'panel', id: PANEL, viewIds: [view.id], activeViewId: view.id },
    views: { [view.id]: view },
    results: {},
    focusedPanel: PANEL,
  }
}

describe('read_workspace reports how a collection can be browsed', () => {
  test('a relation offers ordering and both pagers', () => {
    const snap = snapshotWorkspace(workspaceWith({ kind: 'relation', schema: 'public', name: 't' }))
    assert.deepEqual(snap.views[0]?.browse, collectionBrowseStyle({
      kind: 'relation', schema: 'public', name: 't',
    }))
    assert.deepEqual(briefViews(snap)[0]?.browse, ['sort', 'offsetPaging', 'cursorPaging'])
  })

  /**
   * The case the AI kept getting wrong. SCAN order is an artefact of the hash
   * table, so a keyspace cannot be sorted and has no addressable row — the brief
   * has to say so before a sort is attempted, not after.
   */
  test('a redis keyspace offers neither ordering nor an offset', () => {
    const snap = snapshotWorkspace(workspaceWith({ kind: 'keyPattern', pattern: 'user:*' }))
    assert.deepEqual(briefViews(snap)[0]?.browse, ['cursorPaging'])
    assert.match(renderPanelBrief(snap), /browse=cursorPaging/)
  })

  test('a vector collection warns that ordering ends the paging', () => {
    const snap = snapshotWorkspace(workspaceWith({ kind: 'vectorCollection', collection: 'docs' }))
    assert.deepEqual(briefViews(snap)[0]?.browse, ['sort', 'cursorPaging', 'sortEndsPaging'])
  })

  test('a view with no collection reports nothing rather than a misleading default', () => {
    const ws = workspaceWith({ kind: 'relation', schema: '', name: 't' })
    const viewId = asViewId('v_2')
    ws.views[viewId] = { id: viewId, kind: 'query', connId: CONN, text: 'select 1', status: 'idle' }
    const snap = snapshotWorkspace(ws)
    const query = snap.views.find((v) => v.kind === 'query')
    assert.equal(query?.browse, undefined, 'a free-form query browses nothing')
    assert.equal(briefViews(snap).find((v) => v.kind === 'query')?.browse, undefined)
  })
})
