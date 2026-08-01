/**
 * Accessibility: the strings only a screen reader ever reads, plus the two
 * labels the tab strip needs to be a legal ARIA tablist.
 *
 * Its own domain file, and not lines added to `panel.ts`, for two reasons. The
 * practical one is that `panel.ts` is being edited by the tab-bar work at the
 * same time. The lasting one is that these strings answer to a different
 * standard than the rest of the catalog: nobody will ever see them next to the
 * thing they describe, so they have to carry their own context. "Query" is a
 * fine tab label because the tab is visibly one of three; as an announcement it
 * is useless, which is why every message here names a position.
 *
 * `{content}` is assembled by `announce.ts` rather than written out per case:
 * the panel-focus and tab-activation sentences have to describe the same view
 * the same way, or a user arrowing between panels and then between tabs hears
 * one view called two different things.
 */
export const a11y = {
  /* Labels on the layout itself. `.panel` is `role="group"`, so the label is
   * what a screen reader reads on entering it — it has to say which panel this
   * is, not merely that a panel exists. */
  'a11y.panel.label': 'Panel {index}: {title}',
  'a11y.panel.empty': 'Empty panel {index}',

  /* Position of one tab within its strip. Folded into the announcements below,
   * and deliberately omitted when a panel holds a single tab: "tab 1 of 1" is
   * noise on the overwhelmingly common panel. */
  'a11y.tab.position': '{title}, tab {index} of {total}',

  /* The live region.
   *
   * These fire **only when DOM focus did not move** — when focus does move, the
   * `role="group"` label is announced by the screen reader on its own and a
   * second spoken sentence would be a stutter. The uncovered cases are real: a
   * background command (MCP) changing `focusedPanel` while the human is typing
   * in the sidebar, or activating a tab in a panel that is not the focused one.
   * Nothing else in the window is audible then.
   *
   * Word order differs between the two on purpose. Focus moving is about *where
   * you now are*, so the panel comes first; a tab changing is about *what is now
   * showing*, so the view comes first and the panel is the trailing context. */
  'a11y.announce.panelFocused': 'Panel {index} of {total}, {content}',
  'a11y.announce.tabActivated': '{content}, panel {index} of {total}',

  /* Label on the live region itself, so a screen reader listing landmarks and
   * regions can say what this one is for. */
  'a11y.region.label': 'Layout announcements',

  /* The tab strip. Consumed by the tab-bar components; they live here because
   * they exist for the accessibility tree, not for the eye — the strip is
   * visibly a strip of tabs, and neither string is drawn on screen. */
  'panel.tabs.listLabel': 'Panel tabs',
  'panel.tab.close': 'Close {title}',
} as const

export type A11yMessages = typeof a11y
