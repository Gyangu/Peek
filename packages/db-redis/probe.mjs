import { createClient, RESP_TYPES } from 'redis'

const c = createClient({ url: 'redis://localhost:6379', disableOfflineQueue: true })
c.on('error', () => {})
await c.connect()
console.log('dbsize', await c.dbSize())

const P = 'peek:probe:'
await c.set(P + 'str', 'hello world')
await c.hSet(P + 'hash', { a: '1', b: '2' })
await c.rPush(P + 'list', ['x', 'y', 'z'])
await c.sAdd(P + 'set', ['m1', 'm2'])
await c.zAdd(P + 'zset', [
  { value: 'a', score: 1.5 },
  { value: 'b', score: 2 },
])
await c.xAdd(P + 'stream', '*', { f: 'v' })
await c.pExpire(P + 'str', 60000)

const s = await c.scan('0', { MATCH: P + '*', COUNT: 100 })
console.log('scan', typeof s.cursor, s.cursor, s.keys)

// pipelining via same-tick promises
const keys = s.keys
const t0 = Date.now()
const results = await Promise.allSettled(
  keys.flatMap((k) => [c.type(k), c.pTTL(k), c.memoryUsage(k), c.objectEncoding(k)]),
)
console.log(
  'pipeline ms',
  Date.now() - t0,
  results.map((r) => r.status + ':' + JSON.stringify(r.value ?? r.reason?.message)).join(' | '),
)

console.log('hScan', JSON.stringify(await c.hScan(P + 'hash', '0', { COUNT: 10 })))
console.log('sScan', JSON.stringify(await c.sScan(P + 'set', '0')))
console.log('zScan', JSON.stringify(await c.zScan(P + 'zset', '0')))
console.log('zRangeWithScores', JSON.stringify(await c.zRangeWithScores(P + 'zset', 0, -1)))
console.log('xRange', JSON.stringify(await c.xRange(P + 'stream', '-', '+', { COUNT: 5 })))
console.log('lRange', JSON.stringify(await c.lRange(P + 'list', 0, -1)))
console.log(
  'strLen',
  await c.strLen(P + 'str'),
  'getRange',
  JSON.stringify(await c.getRange(P + 'str', 0, 4)),
)
console.log('hStrLen', await c.hStrLen(P + 'hash', 'a'))
console.log('configGet', JSON.stringify(await c.configGet('databases')))
const info = await c.info('keyspace')
console.log('info keyspace', JSON.stringify(info))
const srv = await c.info('server')
console.log('info server head', srv.split('\n').slice(0, 6))

const bin = c.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
const b = await bin.getRange(P + 'str', 0, 4)
console.log('bin getRange', Buffer.isBuffer(b), b)

// wrong type error
try {
  await c.lRange(P + 'hash', 0, 1)
} catch (e) {
  console.log('wrongtype', e.constructor.name, e.message)
}
// nonexistent
console.log(
  'type missing',
  await c.type(P + 'nope'),
  'pttl missing',
  await c.pTTL(P + 'nope'),
  'memusage missing',
  await c.memoryUsage(P + 'nope'),
)
try {
  console.log('objenc missing', await c.objectEncoding(P + 'nope'))
} catch (e) {
  console.log('objenc missing err', e.message)
}

// abort signal support?
console.log('has scanIterator', typeof c.scanIterator)

for (const k of keys) await c.del(k)
;(await c.close?.()) ?? (await c.quit())
