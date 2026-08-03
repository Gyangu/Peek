import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/* ==================================================================
 * The disclosure gate has to survive the click that triggers it.
 *
 * ## The incident
 *
 * `ConsentDialog` is rendered by whichever surface called `useContextActions`,
 * because the attachment the user asked for is *held* in that hook's own state
 * until the disclosure is answered. `SelectionActionBar` gets this right for
 * free: it swaps itself for the dialog and stays mounted.
 *
 * `ContextMenu` did not. Choosing an item called `onClose()` unconditionally,
 * and `onClose` unmounts the menu — which took the hook, the held attachment and
 * the dialog with it. Measured in the running app against a real PostgreSQL,
 * with consent not yet given:
 *
 *   selection bar  → `.ctx-consent` appears ("This data will be sent to Anthropic")
 *   right-click    → menu closes, no dialog, no chip, no toast, nothing at all
 *
 * So the feature's most discoverable path silently did nothing on first use, and
 * the gate that is supposed to fire before any data leaves the machine never
 * fired from it. Both failures are invisible: no error, no console output.
 *
 * ## What is asserted
 *
 * That no `onClose()` inside the item handler is unconditional. The check is on
 * the AST rather than on the text, so reformatting cannot fake a pass and the
 * *shape* of the fix is what is pinned — not one particular spelling of it.
 * ================================================================== */

const SRC = readFileSync(fileURLToPath(new URL('../ContextMenu.tsx', import.meta.url)), 'utf8')
const sf = ts.createSourceFile('ContextMenu.tsx', SRC, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

/**
 * Every `onClose={...}` and `onSelect: …` body in the file.
 *
 * It used to read `onClick` attributes, because this component drew its own
 * buttons. It draws none now — `<Menu>` owns the DOM and this file supplies
 * nodes — so the same question ("can choosing an item unmount the hook that is
 * holding the attachment?") is asked of the two places that can still answer it
 * wrongly: the `onSelect` that stages, and the `onClose` handed to the menu.
 */
function handlerBodies(): ts.Node[] {
  const out: ts.Node[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node)
      && node.name.getText(sf) === 'onClose'
      && node.initializer !== undefined
      && ts.isJsxExpression(node.initializer)
      && node.initializer.expression !== undefined
    ) {
      out.push(node.initializer.expression)
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'onSelect') {
      out.push(node.initializer)
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

/** Calls to `onClose()` inside `root`, each tagged with whether a condition guards it. */
function closeCalls(root: ts.Node): { guarded: boolean }[] {
  const out: { guarded: boolean }[] = []
  const walk = (node: ts.Node, guarded: boolean): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'onClose') {
      out.push({ guarded })
      return
    }
    const nowGuarded = guarded || ts.isIfStatement(node) || ts.isConditionalExpression(node)
      || node.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ts.forEachChild(node, (child) => {
      walk(child, nowGuarded)
    })
  }
  walk(root, false)
  return out
}

describe('the right-click menu must not close over its own consent dialog', () => {
  it('reads the gate synchronously, because add() resolves too late to decide', () => {
    assert.match(
      SRC,
      /import \{ hasContextConsent \} from '\.\/consent'/,
      'the menu has to consult the gate itself; `add()` returns a promise, and by the time it '
      + 'settles the decision to unmount has already been taken',
    )
  })

  it('staging an attachment does not itself close the menu', () => {
    const handlers = handlerBodies()
    assert.ok(handlers.length > 0, 'no handlers found — the parse is wrong, not the component')

    const staging = handlers.filter((h) => /actions\.add\(/.test(h.getText(sf)))
    assert.equal(staging.length, 1, 'expected exactly one handler that stages an attachment')
    assert.deepEqual(
      closeCalls(staging[0]!),
      [],
      'the staging handler must not close anything: `<Menu>` closes after every choice on its own, '
      + 'so a close here would be the second one and there is nothing left to guard it',
    )
  })

  it('the close the menu is given is conditional', () => {
    // `<Menu>` calls `onClose` after every choice, which is right everywhere else
    // in the window and wrong for exactly this one: closing while the disclosure
    // is pending unmounts the hook holding the attachment, so the dialog never
    // renders and the gesture is dropped without a trace.
    const onClose = handlerBodies().filter((h) => /onClose\(/.test(h.getText(sf)))
    assert.equal(onClose.length, 1, 'expected the menu to be handed a close that consults the gate')

    const calls = closeCalls(onClose[0]!)
    assert.ok(calls.length > 0, 'the menu still has to close on the ordinary path')
    assert.ok(
      calls.every((c) => c.guarded),
      'an unconditional onClose() here is the original incident: the right-click path silently did '
      + 'nothing at all on first use, with no error and no console output',
    )
  })

  it('the dialog is rendered by this component, not delegated to a parent', () => {
    // The parent's `useContextActions` is a *different* hook instance with its own
    // `held`, so delegating cannot work even when a parent does render a dialog.
    assert.match(SRC, /actions\.consentPending/)
    assert.match(SRC, /<ConsentDialog/)
  })
})
