import { optionalDepStub } from './optional-dep-stub'

/**
 * Stub for `@node-rs/xxhash`, aliased in electron.vite.config.ts.
 *
 * `@redis/client` dynamic-imports it from `digest()` (the helper behind the
 * `IFDEQ` / `IFDNE` conditional SET arguments), inside its own try/catch. peek
 * does not use those, and the throwing Proxy lands in that catch as the
 * library's own "requires the @node-rs/xxhash package" error.
 */
export const xxh3 = optionalDepStub('@node-rs/xxhash', 'Redis digest()/IFDEQ/IFDNE are unavailable.')

export default optionalDepStub('@node-rs/xxhash', 'Redis digest()/IFDEQ/IFDNE are unavailable.')
