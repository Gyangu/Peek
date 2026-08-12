/**
 * `entry.driver` — what a driver-host process loads for this package.
 *
 * Nothing is imported, and that is the fixture's whole point: a package the user
 * dropped into `~/.peek/packages/` was built somewhere else and resolves nothing
 * from this workspace. `driver.mjs` is self-contained by construction for the
 * five in-repo packages too (`build-packages.mjs` inlines the client); writing
 * it by hand here is how this fixture stays a *third-party* package rather than
 * a workspace package sitting in an unusual directory.
 *
 * The database is two constant rows. A fixture that opened a socket would fail
 * for reasons that have nothing to do with the loading path it exists to
 * exercise.
 */

const CAPABILITIES = new Set(['introspect', 'collectionScan'])

const COLUMNS = [
  { name: 'id', logical: 'number', nativeType: 'int', primaryKey: true },
  { name: 'note', logical: 'string', nativeType: 'text' },
]

/** Column-major, the shape `ChunkFrame.cols` takes. */
const ROWS = [
  [1, 2],
  ['first', 'second'],
]

// `schema: ''` rather than an absent key: `RelationRefSchema` requires the field
// and documents '' as what a database without a schema layer puts there. A ref
// that omits it survives `introspect` — the driver host does not re-validate what
// a driver hands back — and is then refused by `open_view`, which does.
const COLLECTION = { kind: 'relation', schema: '', name: 'rows' }

/** One frame, then null — the smallest cursor that still ends the way a real one does. */
function twoRowCursor(resultId) {
  let sent = false
  return {
    resultId,
    schema: COLUMNS,
    async next() {
      if (sent) return null
      sent = true
      return {
        resultId,
        seq: 0,
        schema: COLUMNS,
        cols: ROWS,
        rowCount: 2,
        done: { rows: 2, elapsedMs: 0 },
      }
    },
    async close() {},
  }
}

class EchoSession {
  driverId = 'echo'
  capabilities = CAPABILITIES
  serverInfo = { version: '0.1.0', flavor: 'echo' }

  async close() {}

  async listChildren(parentId) {
    if (parentId !== null) return []
    return [
      {
        id: 'relation:rows',
        name: 'rows',
        kind: 'table',
        hasChildren: false,
        ref: COLLECTION,
        detail: '2 rows',
      },
    ]
  }

  async describeCollection(ref) {
    return { ref, columns: COLUMNS, primaryKey: ['id'], rowCountEstimate: 2 }
  }

  async scan(req) {
    return twoRowCursor(req.resultId)
  }
}

export const drivers = [
  {
    meta: { id: 'echo', displayName: 'Echo' },
    capabilities: CAPABILITIES,
    async connect() {
      return new EchoSession()
    },
  },
]
