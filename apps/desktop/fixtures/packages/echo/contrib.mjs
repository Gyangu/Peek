/**
 * `entry.contrib` — what this package's own host process loads.
 *
 * One display and nothing else: `viewKinds` and `tools` are absent rather than
 * empty, the spelling `db-postgres` uses for "this package has none".
 *
 * ## `echo_ping` is declared in the manifest and has no mapping here
 *
 * On purpose, and it is half of what this fixture is for. Since §4duodevicies
 * `tools/list` is answered from `peek-package.json` alone — listing a tool forks
 * nothing — so a package's tools can be *listed* by a peek that cannot run one
 * of them. That asymmetry is what makes twenty installed packages twenty
 * processes not started (§2.4bis(d), acceptance 31), and writing a mapping here
 * would hide it behind code this fixture's host cannot load anyway: the package
 * host is still Phase B and refuses `echo` outright (§4terdecies(h)).
 *
 * What smoke asserts with it: install echo and `echo_ping` joins the tool list,
 * uninstall it and the name goes. Calling it fails, structured and loud.
 *
 * The three strings are the reason a fixture needs this file at all. Since
 * §2.3(b-2) the connection book stores a label and a detail computed by the
 * *package*, so a package without a display is one whose rows in the sidebar
 * have no name — and the loading path this fixture exercises ends at a sidebar
 * row.
 *
 * No database client is reachable from here, which is the rule this half exists
 * to keep (design §2.1): the package host computes strings, the driver host
 * opens connections, and they are separate processes so that this file cannot
 * quietly grow a socket.
 */

export const displays = [
  {
    driverId: 'echo',
    display: {
      label: (config) => config.url ?? 'echo',
      detail: (config) => `Echo fixture at ${config.url ?? 'echo://localhost'}`,
      endpoint: (config) => config.url ?? 'echo://localhost',
    },
  },
]
