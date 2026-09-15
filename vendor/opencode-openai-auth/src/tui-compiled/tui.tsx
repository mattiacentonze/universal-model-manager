import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEffect, createSignal, For, onCleanup, Show } from "opentui:runtime-module:solid-js";
import { createLogger } from "./logger.js";
import { createRpcClient } from "./rpc/rpc-client.js";
import { resolveRpcDir } from "./rpc/rpc-dir.js";
import { computeQuotaPacing, DEFAULT_SIDEBAR_STATE, getCollapsedQuotaSummary, getPresentQuotaWindows, getSidebarState, resolveActiveAccount, resolveSessionSidebarRouting, resolveSessionStickyAccount } from "./sidebar-state.js";
import { openCommandDialog } from "./tui/command-dialogs.js";
import { computeEffectiveOrder, DEFAULT_SLOT_ORDER, PLUGIN_KEY, queueTuiPreferenceUpdate, readTuiPreferencesFile, resolveOpenaiAuthPrefs, watchTuiPreferences } from "./tui-preferences.js";
const RPC_POLL_MS = 500;
let rpcPollStarted = false;
const log = createLogger('rpc-tui');
const ID = 'cortexkit.openai-auth';
export function buildApplyRequest(command, arguments_, sessionId) {
  return {
    command,
    arguments: arguments_,
    sessionId
  };
}

// Read package metadata from either the raw src/ entry or its generated
// src/tui-compiled/ counterpart. Avoid a JSON import because package.json sits
// outside the declaration build's rootDir.
const PLUGIN_VERSION = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const packageFile of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const raw = readFileSync(packageFile, 'utf8');
      const version = JSON.parse(raw).version;
      if (version) return version;
    } catch {
      // Try the path for the other TUI entry layout.
    }
  }
  return '';
})();

// biome-ignore lint/suspicious/noExplicitAny: opentui border prop not typed in plugin tui surface
const SINGLE_BORDER = {
  type: 'single'
};
// Tone -> theme token. Theme tokens only — never hardcoded colors. Fallbacks
// resolve to other theme tokens so the sidebar always tracks the active theme.
function toneColor(theme, tone) {
  switch (tone) {
    case 'ok':
      return theme.success ?? theme.accent;
    case 'warn':
      return theme.warning ?? theme.accent;
    case 'err':
      return theme.error ?? theme.accent;
    case 'muted':
      return theme.textMuted ?? theme.text;
    case 'accent':
      return theme.accent ?? theme.text;
    default:
      return theme.text;
  }
}
function usageTone(usedPct, appearance) {
  if (usedPct < appearance.warnThreshold) return 'ok';
  if (usedPct < appearance.errorThreshold) return 'warn';
  return 'err';
}
const PACE_RESERVE_CHAR = '\u2592';
const PACE_DEFICIT_CHAR = '\u2593';

// Variant C pacing bar: normal fill up to min(used, pace), then a pace
// segment covering the gap — headroom being banked (reserve, ok tone) or the
// overshoot itself (deficit, err tone) — then empty cells. Without pacing the
// bar renders as a single fill+empty pair, identical to the pre-pacing look.
// Empty text nodes still occupy a phantom cell in the opentui flex row, so
// zero-length segments are dropped from every return path (plain and pacing).
function quotaBarSegments(usedPct, appearance, pacing) {
  const width = appearance.barWidth;
  const cells = pct => Math.max(0, Math.min(Math.round(pct / 100 * width), width));
  const usedCells = cells(usedPct);
  const fillTone = usageTone(usedPct, appearance);
  const plain = [{
    text: appearance.barFilledChar.repeat(usedCells),
    tone: fillTone
  }, {
    text: appearance.barEmptyChar.repeat(width - usedCells),
    tone: fillTone
  }];
  if (!pacing) return plain.filter(segment => segment.text.length > 0);
  const paceCells = cells(pacing.pacePercent);
  const lo = Math.min(usedCells, paceCells);
  const hi = Math.max(usedCells, paceCells);
  if (hi === lo) return plain.filter(segment => segment.text.length > 0);
  const overspent = usedCells > paceCells;
  return [{
    text: appearance.barFilledChar.repeat(lo),
    tone: fillTone
  }, {
    text: (overspent ? PACE_DEFICIT_CHAR : PACE_RESERVE_CHAR).repeat(hi - lo),
    tone: overspent ? 'err' : 'ok'
  }, {
    text: appearance.barEmptyChar.repeat(width - hi),
    tone: fillTone
  }].filter(segment => segment.text.length > 0);
}
export function formatResetIn(resetsAt) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const rm = mins % 60;
    return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  }
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}
function formatUntil(until) {
  if (!until) return '';
  const ms = until - Date.now();
  if (ms <= 0) return 'now';
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
}

// --- Reusable components (aft-style) ---------------------------------------

function SectionHeader(props) {
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text"),
      _el$3 = _$createElement("b");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "width", '100%');
    _$insertNode(_el$2, _el$3);
    _$insert(_el$3, () => props.title);
    _$effect(_p$ => {
      var _v$ = props.marginTop ?? 1,
        _v$2 = props.theme.text;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "marginTop", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}
function StatRow(props) {
  return (() => {
    var _el$4 = _$createElement("box"),
      _el$5 = _$createElement("text"),
      _el$6 = _$createElement("text"),
      _el$7 = _$createElement("b");
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$6);
    _$setProp(_el$4, "width", '100%');
    _$setProp(_el$4, "flexDirection", 'row');
    _$setProp(_el$4, "justifyContent", 'space-between');
    _$insert(_el$5, () => props.label);
    _$insertNode(_el$6, _el$7);
    _$insert(_el$7, () => props.value);
    _$effect(_p$ => {
      var _v$3 = props.theme.textMuted,
        _v$4 = toneColor(props.theme, props.tone ?? 'text');
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$5, "fg", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$4, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$4;
  })();
}

// Compact row for the collapsed view: muted label left, caller-provided value
// right. Mirrors StatRow's layout so columns line up.
function CollapsedRow(props) {
  return (() => {
    var _el$8 = _$createElement("box"),
      _el$9 = _$createElement("text");
    _$insertNode(_el$8, _el$9);
    _$setProp(_el$8, "width", '100%');
    _$setProp(_el$8, "flexDirection", 'row');
    _$setProp(_el$8, "justifyContent", 'space-between');
    _$insert(_el$9, () => props.label);
    _$insert(_el$8, () => props.children, null);
    _$effect(_$p => _$setProp(_el$9, "fg", props.theme.textMuted, _$p));
    return _el$8;
  })();
}
// Maps present quota windows onto display rows and computes pacing against each
// dynamic duration or the historical 5h/7d duration for legacy snapshots.
export function buildQuotaRowsForDisplay(quota, now, pacingEnabled) {
  return getPresentQuotaWindows(quota).map(row => ({
    key: row.key,
    label: row.label,
    window: row.window,
    pacing: pacingEnabled && row.windowMs !== null ? computeQuotaPacing(row.window, row.windowMs, now) : null
  }));
}
export function isQuotaLoaded(quota) {
  return quota !== null;
}
export function getQuotaMetadataRows(state) {
  const rows = [];
  if (state.planType) rows.push({
    label: 'Plan',
    value: state.planType
  });
  if (state.credits !== undefined) {
    rows.push({
      label: 'Credits',
      value: String(state.credits)
    });
  }
  return rows;
}
export function getAccountMetadataRows(resetCredits) {
  return resetCredits === undefined ? [] : [{
    label: 'resets',
    value: String(resetCredits)
  }];
}

// Quota window row: muted label left, tone-colored bar + percentage right,
// with an optional muted reset suffix. When pacing data is present, the bar
// gains a pace segment and an off-pace window adds a muted subline with the
// reserve/deficit delta and the projected runout.
function QuotaRow(props) {
  const used = () => props.window?.usedPercent ?? 0;
  const reset = () => formatResetIn(props.window?.resetsAt);
  const paceLine = () => {
    const pacing = props.pacing;
    if (!pacing || pacing.state === 'on-pace') return null;
    const pct = Math.round(Math.abs(pacing.deltaPercent));
    if (pacing.state === 'reserve') return `reserve ${pct}% \u00b7 lasts`;
    return pacing.runsOutAt ? `deficit ${pct}% \u00b7 out in ${formatResetIn(pacing.runsOutAt)}` : `deficit ${pct}% \u00b7 lasts`;
  };
  return _$createComponent(Show, {
    get when() {
      return props.window;
    },
    get fallback() {
      return (() => {
        var _el$17 = _$createElement("box"),
          _el$18 = _$createElement("text"),
          _el$19 = _$createElement("text");
        _$insertNode(_el$17, _el$18);
        _$insertNode(_el$17, _el$19);
        _$setProp(_el$17, "width", '100%');
        _$setProp(_el$17, "flexDirection", 'row');
        _$insert(_el$18, () => props.label.padEnd(3));
        _$insertNode(_el$19, _$createTextNode(`—`));
        _$effect(_p$ => {
          var _v$9 = props.theme.textMuted,
            _v$0 = props.theme.textMuted;
          _v$9 !== _p$.e && (_p$.e = _$setProp(_el$18, "fg", _v$9, _p$.e));
          _v$0 !== _p$.t && (_p$.t = _$setProp(_el$19, "fg", _v$0, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$17;
      })();
    },
    get children() {
      return [(() => {
        var _el$0 = _$createElement("box"),
          _el$1 = _$createElement("box"),
          _el$10 = _$createElement("text"),
          _el$11 = _$createElement("text");
        _$insertNode(_el$0, _el$1);
        _$setProp(_el$0, "width", '100%');
        _$setProp(_el$0, "flexDirection", 'row');
        _$setProp(_el$0, "justifyContent", 'space-between');
        _$insertNode(_el$1, _el$10);
        _$insertNode(_el$1, _el$11);
        _$setProp(_el$1, "flexDirection", 'row');
        _$insert(_el$10, () => props.label.padEnd(3));
        _$insert(_el$1, _$createComponent(For, {
          get each() {
            return quotaBarSegments(used(), props.appearance, props.pacing);
          },
          children: segment => (() => {
            var _el$21 = _$createElement("text");
            _$insert(_el$21, () => segment.text);
            _$effect(_$p => _$setProp(_el$21, "fg", toneColor(props.theme, segment.tone), _$p));
            return _el$21;
          })()
        }), _el$11);
        _$insert(_el$11, () => ` ${String(Math.round(used())).padStart(3)}%`);
        _$insert(_el$0, _$createComponent(Show, {
          get when() {
            return reset();
          },
          get children() {
            var _el$12 = _$createElement("text");
            _$insert(_el$12, reset);
            _$effect(_$p => _$setProp(_el$12, "fg", props.theme.textMuted, _$p));
            return _el$12;
          }
        }), null);
        _$effect(_p$ => {
          var _v$5 = props.theme.textMuted,
            _v$6 = toneColor(props.theme, usageTone(used(), props.appearance));
          _v$5 !== _p$.e && (_p$.e = _$setProp(_el$10, "fg", _v$5, _p$.e));
          _v$6 !== _p$.t && (_p$.t = _$setProp(_el$11, "fg", _v$6, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$0;
      })(), _$createComponent(Show, {
        get when() {
          return paceLine();
        },
        get children() {
          var _el$13 = _$createElement("box"),
            _el$14 = _$createElement("text"),
            _el$16 = _$createElement("text");
          _$insertNode(_el$13, _el$14);
          _$insertNode(_el$13, _el$16);
          _$setProp(_el$13, "width", '100%');
          _$setProp(_el$13, "flexDirection", 'row');
          _$insertNode(_el$14, _$createTextNode(`   `));
          _$insert(_el$16, paceLine);
          _$effect(_p$ => {
            var _v$7 = props.theme.textMuted,
              _v$8 = toneColor(props.theme, props.pacing?.state === 'deficit' ? 'warn' : 'muted');
            _v$7 !== _p$.e && (_p$.e = _$setProp(_el$14, "fg", _v$7, _p$.e));
            _v$8 !== _p$.t && (_p$.t = _$setProp(_el$16, "fg", _v$8, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$13;
        }
      })];
    }
  });
}

// Account block: header row (name + status word) then per-window quota rows.
// Pacing is computed here — per window, against the wall clock at render time
// (re-evaluated on every state poll) — and disabled by passing false.
function AccountBlock(props) {
  const statusWord = () => props.killed ? 'blocked' : props.active ? 'active' : 'idle';
  const statusTone = () => props.killed ? 'err' : props.active ? 'ok' : 'muted';
  const rows = () => buildQuotaRowsForDisplay(props.quota, Date.now(), props.pacingEnabled);
  return (() => {
    var _el$22 = _$createElement("box"),
      _el$23 = _$createElement("box"),
      _el$24 = _$createElement("text"),
      _el$25 = _$createElement("b"),
      _el$26 = _$createElement("text"),
      _el$27 = _$createElement("b");
    _$insertNode(_el$22, _el$23);
    _$setProp(_el$22, "width", '100%');
    _$setProp(_el$22, "flexDirection", 'column');
    _$insertNode(_el$23, _el$24);
    _$insertNode(_el$23, _el$26);
    _$setProp(_el$23, "width", '100%');
    _$setProp(_el$23, "flexDirection", 'row');
    _$setProp(_el$23, "justifyContent", 'space-between');
    _$insertNode(_el$24, _el$25);
    _$insert(_el$25, () => props.name);
    _$insertNode(_el$26, _el$27);
    _$insert(_el$27, statusWord);
    _$insert(_el$22, _$createComponent(Show, {
      get when() {
        return isQuotaLoaded(props.quota);
      },
      get fallback() {
        return (() => {
          var _el$28 = _$createElement("text");
          _$insertNode(_el$28, _$createTextNode(`checking…`));
          _$effect(_$p => _$setProp(_el$28, "fg", props.theme.textMuted, _$p));
          return _el$28;
        })();
      },
      get children() {
        return _$createComponent(Show, {
          get when() {
            return rows().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$30 = _$createElement("text");
              _$insertNode(_el$30, _$createTextNode(`—`));
              _$effect(_$p => _$setProp(_el$30, "fg", props.theme.textMuted, _$p));
              return _el$30;
            })();
          },
          get children() {
            return _$createComponent(For, {
              get each() {
                return rows();
              },
              children: row => _$createComponent(QuotaRow, {
                get theme() {
                  return props.theme;
                },
                get appearance() {
                  return props.appearance;
                },
                get label() {
                  return row.label;
                },
                get window() {
                  return row.window;
                },
                get pacing() {
                  return row.pacing;
                }
              })
            });
          }
        });
      }
    }), null);
    _$insert(_el$22, _$createComponent(For, {
      get each() {
        return getAccountMetadataRows(props.resetCredits);
      },
      children: row => _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        get label() {
          return row.label;
        },
        get value() {
          return row.value;
        },
        tone: "text"
      })
    }), null);
    _$effect(_p$ => {
      var _v$1 = props.marginTop ?? 0,
        _v$10 = props.theme.text,
        _v$11 = toneColor(props.theme, statusTone());
      _v$1 !== _p$.e && (_p$.e = _$setProp(_el$22, "marginTop", _v$1, _p$.e));
      _v$10 !== _p$.t && (_p$.t = _$setProp(_el$24, "fg", _v$10, _p$.t));
      _v$11 !== _p$.a && (_p$.a = _$setProp(_el$26, "fg", _v$11, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$22;
  })();
}

// --- Quota dialog content ---------------------------------------------------

// Renders the same rich visualization as the sidebar (account blocks with
// quota bars + pacing) so the modal matches the sidebar look.
function QuotaDialogContent(props) {
  const prefs = props.controller.prefs;
  const [state, setState] = createSignal(DEFAULT_SIDEBAR_STATE);
  let lastUpdated = 0;
  async function refresh() {
    const next = await readStateFromFile();
    if (next.lastUpdated !== lastUpdated) {
      lastUpdated = next.lastUpdated;
      setState(next);
    }
  }
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs);
    onCleanup(() => clearInterval(timer));
  });
  setTimeout(refresh, 0);
  const theme = () => props.api.theme.current;
  const enabledFallbacks = () => (state().fallbacks ?? []).filter(f => f.enabled);
  const activeId = () => resolveQuotaDialogActiveId(state(), props.sessionId);
  return (() => {
    var _el$32 = _$createElement("box"),
      _el$33 = _$createElement("box"),
      _el$34 = _$createElement("box"),
      _el$35 = _$createElement("text"),
      _el$36 = _$createElement("b");
    _$insertNode(_el$32, _el$33);
    _$setProp(_el$32, "flexDirection", 'column');
    _$setProp(_el$32, "padding", 2);
    _$setProp(_el$32, "width", '100%');
    _$setProp(_el$32, "alignItems", 'center');
    _$insertNode(_el$33, _el$34);
    _$setProp(_el$33, "flexDirection", 'column');
    _$setProp(_el$33, "width", 58);
    _$insertNode(_el$34, _el$35);
    _$setProp(_el$34, "width", '100%');
    _$setProp(_el$34, "justifyContent", 'center');
    _$setProp(_el$34, "marginBottom", 1);
    _$insertNode(_el$35, _el$36);
    _$insertNode(_el$36, _$createTextNode(`Codex Quota`));
    _$insert(_el$33, _$createComponent(AccountBlock, {
      get theme() {
        return theme();
      },
      get appearance() {
        return prefs().appearance;
      },
      name: "main",
      get quota() {
        return state().main?.quota ?? null;
      },
      get killed() {
        return state().main?.killed ?? false;
      },
      get active() {
        return activeId() === 'main';
      },
      get pacingEnabled() {
        return prefs().sections.pacing;
      },
      get resetCredits() {
        return state().main?.resetCredits;
      }
    }), null);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return prefs().sections.fallbackAccounts;
      },
      get children() {
        return _$createComponent(For, {
          get each() {
            return enabledFallbacks();
          },
          children: fb => _$createComponent(AccountBlock, {
            get theme() {
              return theme();
            },
            get appearance() {
              return prefs().appearance;
            },
            get name() {
              return fb.label ?? fb.id;
            },
            get quota() {
              return fb.quota;
            },
            get killed() {
              return fb.killed;
            },
            get active() {
              return activeId() === fb.id;
            },
            get pacingEnabled() {
              return prefs().sections.pacing;
            },
            get resetCredits() {
              return fb.resetCredits;
            },
            marginTop: 1
          })
        });
      }
    }), null);
    _$effect(_$p => _$setProp(_el$35, "fg", theme().text, _$p));
    return _el$32;
  })();
}

// --- State plumbing ---------------------------------------------------------

export async function readStateFromFile() {
  return getSidebarState();
}
export function resolveQuotaDialogActiveId(state, sessionId, now = Date.now()) {
  return sessionId ? resolveSessionSidebarRouting(state, sessionId, now).activeId : state.activeId;
}
export function buildRoutingRowsForDisplay(state, sessionId, now = Date.now()) {
  const routing = resolveSessionSidebarRouting(state, sessionId, now);
  const rows = [{
    label: 'Route',
    value: routing.route,
    tone: 'accent'
  }];
  const pinnedAccountId = resolveSessionStickyAccount(state, sessionId, now);
  if (pinnedAccountId) {
    const pinnedAccount = resolveActiveAccount({
      ...state,
      activeId: pinnedAccountId
    });
    rows.push({
      label: 'Pin',
      value: pinnedAccount.name,
      tone: 'accent'
    });
  }
  return rows;
}
// The TUI may unmount and remount sidebar_content when the user switches
// views (e.g. main -> subagent -> main). A remount re-runs the component
// body, so any signal created inside the component would reset to its
// seed. The controller lives in the plugin closure (process lifetime)
// and owns the durable prefs/collapse signals plus the single shared
// watcher subscription, so collapse and live pref reloads survive the
// remount. No effects or memos here — those need a Solid owner, so the
// poll-interval createEffect stays inside the component.
function createSidebarController(initialPrefs) {
  const [prefs, setPrefs] = createSignal(initialPrefs);
  const seedCollapsed = initialPrefs.rememberCollapsed && initialPrefs.collapsed != null ? initialPrefs.collapsed : initialPrefs.startCollapsed;
  const [collapsed, setCollapsed] = createSignal(seedCollapsed);
  let lastPersistedCollapsed = initialPrefs.collapsed;
  let lastApplied = JSON.stringify(initialPrefs);

  // The watcher lives for the plugin/process lifetime — it is intentionally
  // never disposed. Collapse guard mirrors the race-fix in toggleCollapsed:
  // lastPersistedCollapsed is advanced only once our own write lands, so
  // watcher echoes of the previous persisted value are rejected by the
  // `!==` check and cannot revert a user click.
  watchTuiPreferences(() => {
    void (async () => {
      const next = resolveOpenaiAuthPrefs(await readTuiPreferencesFile());
      const serialized = JSON.stringify(next);
      if (serialized === lastApplied) return;
      lastApplied = serialized;
      setPrefs(next);
      if (next.rememberCollapsed && next.collapsed != null && next.collapsed !== lastPersistedCollapsed) {
        lastPersistedCollapsed = next.collapsed;
        setCollapsed(next.collapsed);
      }
    })();
  });
  function toggleCollapsed() {
    const next = !collapsed();
    setCollapsed(next);
    if (prefs().rememberCollapsed) {
      void queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], next).then(() => {
        lastPersistedCollapsed = next;
      });
    }
  }
  return {
    prefs,
    collapsed,
    toggleCollapsed
  };
}
function QuotaSidebar(props) {
  const prefs = props.controller.prefs;
  const collapsed = props.controller.collapsed;
  const [state, setState] = createSignal(DEFAULT_SIDEBAR_STATE);
  let lastUpdated = 0;
  let debounce = null;
  async function refresh() {
    const next = await readStateFromFile();
    if (next.lastUpdated !== lastUpdated) {
      lastUpdated = next.lastUpdated;
      setState(next);
    }
  }
  function scheduleRefresh() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void refresh();
    }, prefs().refreshDebounceMs);
  }

  // Background poller (server and TUI run as separate module instances, so we
  // sync through the state file) plus event-driven refreshes for low latency.
  // The interval rebuilds whenever pollMs changes.
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs);
    onCleanup(() => clearInterval(timer));
  });
  const unsubs = [props.api.event.on('session.updated', scheduleRefresh), props.api.event.on('message.updated', scheduleRefresh)];
  setTimeout(refresh, 300);
  onCleanup(() => {
    if (debounce) clearTimeout(debounce);
    for (const u of unsubs) u();
  });
  const theme = () => props.api.theme.current;
  const enabledFallbacks = () => (state().fallbacks ?? []).filter(f => f.enabled);
  const hasData = () => state().main?.quota != null || enabledFallbacks().length > 0;
  const headerLabel = () => {
    const name = prefs().header.label;
    return !hasData() ? name : collapsed() ? `\u25b6 ${name}` : `\u25bc ${name}`;
  };
  const sessionRouting = () => resolveSessionSidebarRouting(state(), props.sessionId);
  const sessionState = () => ({
    ...state(),
    activeId: sessionRouting().activeId,
    route: sessionRouting().route
  });
  const activeAccount = () => resolveActiveAccount(sessionState());
  const activeQuotaSummary = () => getCollapsedQuotaSummary(activeAccount().quota);
  const activePacingDeficit = () => {
    if (!prefs().sections.pacing) return false;
    return buildQuotaRowsForDisplay(activeAccount().quota, Date.now(), true).some(row => row.pacing?.state === 'deficit');
  };
  const activeQuotaTone = () => {
    const summary = activeQuotaSummary();
    const values = [summary.primaryUsedPercent, summary.secondaryUsedPercent].filter(value => value != null);
    // Pacing deficit is an advisory projection, not actual quota exhaustion,
    // so it can only BUMP the usage tone up to warn at most — never soften a
    // real warn/err usage reading and never paint a true red.
    const base = values.length > 0 ? usageTone(Math.max(...values), prefs().appearance) : 'muted';
    if (!activePacingDeficit()) return base;
    return base === 'ok' || base === 'muted' ? 'warn' : base;
  };
  const killedNames = () => [state().main?.killed ? 'main' : '', ...enabledFallbacks().filter(f => f.killed).map(f => f.label ?? f.id)].filter(Boolean);
  const quotaBackedOff = () => state().main?.quotaBackedOff === true;
  const refreshBackedOff = () => state().main?.refreshBackedOff === true;
  const degraded = () => killedNames().length > 0 || quotaBackedOff() || refreshBackedOff();
  return (() => {
    var _el$38 = _$createElement("box"),
      _el$39 = _$createElement("box"),
      _el$40 = _$createElement("box"),
      _el$41 = _$createElement("text"),
      _el$42 = _$createElement("b");
    _$insertNode(_el$38, _el$39);
    _$setProp(_el$38, "width", '100%');
    _$setProp(_el$38, "flexDirection", 'column');
    _$setProp(_el$38, "border", SINGLE_BORDER);
    _$setProp(_el$38, "paddingTop", 1);
    _$setProp(_el$38, "paddingBottom", 1);
    _$setProp(_el$38, "paddingLeft", 1);
    _$setProp(_el$38, "paddingRight", 1);
    _$insertNode(_el$39, _el$40);
    _$setProp(_el$39, "width", '100%');
    _$setProp(_el$39, "flexDirection", 'row');
    _$setProp(_el$39, "justifyContent", 'space-between');
    _$setProp(_el$39, "alignItems", 'center');
    _$setProp(_el$39, "onMouseDown", () => {
      if (hasData()) props.controller.toggleCollapsed();
    });
    _$insertNode(_el$40, _el$41);
    _$setProp(_el$40, "paddingLeft", 1);
    _$setProp(_el$40, "paddingRight", 1);
    _$insertNode(_el$41, _el$42);
    _$insert(_el$42, headerLabel);
    _$insert(_el$39, _$createComponent(Show, {
      get when() {
        return degraded();
      },
      get fallback() {
        return _$createComponent(Show, {
          get when() {
            return prefs().header.showVersion && PLUGIN_VERSION !== '';
          },
          get children() {
            var _el$51 = _$createElement("text");
            _$insert(_el$51, `v${PLUGIN_VERSION}`);
            _$effect(_$p => _$setProp(_el$51, "fg", theme().textMuted, _$p));
            return _el$51;
          }
        });
      },
      get children() {
        var _el$43 = _$createElement("box"),
          _el$44 = _$createElement("text"),
          _el$45 = _$createElement("b");
        _$insertNode(_el$43, _el$44);
        _$setProp(_el$43, "paddingLeft", 1);
        _$setProp(_el$43, "paddingRight", 1);
        _$insertNode(_el$44, _el$45);
        _$insertNode(_el$45, _$createTextNode(`LIMITED`));
        _$effect(_p$ => {
          var _v$12 = theme().warning,
            _v$13 = theme().background;
          _v$12 !== _p$.e && (_p$.e = _$setProp(_el$43, "backgroundColor", _v$12, _p$.e));
          _v$13 !== _p$.t && (_p$.t = _$setProp(_el$44, "fg", _v$13, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$43;
      }
    }), null);
    _$insert(_el$38, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!collapsed())() && hasData();
      },
      get children() {
        return _$createComponent(CollapsedRow, {
          get theme() {
            return theme();
          },
          get label() {
            return activeAccount().name;
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return activeQuotaSummary().text != null;
              },
              get fallback() {
                return (() => {
                  var _el$52 = _$createElement("text");
                  _$insertNode(_el$52, _$createTextNode(`—`));
                  _$effect(_$p => _$setProp(_el$52, "fg", theme().textMuted, _$p));
                  return _el$52;
                })();
              },
              get children() {
                var _el$47 = _$createElement("box"),
                  _el$48 = _$createElement("text"),
                  _el$49 = _$createElement("b"),
                  _el$50 = _$createElement("text");
                _$insertNode(_el$47, _el$48);
                _$insertNode(_el$47, _el$50);
                _$setProp(_el$47, "flexDirection", 'row');
                _$insertNode(_el$48, _el$49);
                _$insert(_el$49, () => activeQuotaSummary().text);
                _$insert(_el$50, () => activeAccount().killed ? ' \u2298' : ' \u25cf');
                _$effect(_p$ => {
                  var _v$14 = toneColor(theme(), activeQuotaTone()),
                    _v$15 = toneColor(theme(), activeAccount().killed ? 'err' : activeQuotaTone());
                  _v$14 !== _p$.e && (_p$.e = _$setProp(_el$48, "fg", _v$14, _p$.e));
                  _v$15 !== _p$.t && (_p$.t = _$setProp(_el$50, "fg", _v$15, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$47;
              }
            });
          }
        });
      }
    }), null);
    _$insert(_el$38, _$createComponent(Show, {
      get when() {
        return !collapsed() || !hasData();
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return hasData();
          },
          get fallback() {
            return (() => {
              var _el$54 = _$createElement("box"),
                _el$55 = _$createElement("text");
              _$insertNode(_el$54, _el$55);
              _$setProp(_el$54, "marginTop", 1);
              _$setProp(_el$54, "width", '100%');
              _$insertNode(_el$55, _$createTextNode(`Waiting for quota…`));
              _$effect(_$p => _$setProp(_el$55, "fg", theme().textMuted, _$p));
              return _el$54;
            })();
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return prefs().sections.quota;
              },
              get children() {
                return [_$createComponent(SectionHeader, {
                  get theme() {
                    return theme();
                  },
                  title: "Quota"
                }), _$createComponent(AccountBlock, {
                  get theme() {
                    return theme();
                  },
                  get appearance() {
                    return prefs().appearance;
                  },
                  name: "main",
                  get quota() {
                    return state().main?.quota ?? null;
                  },
                  get killed() {
                    return state().main?.killed ?? false;
                  },
                  get active() {
                    return sessionRouting().activeId === 'main';
                  },
                  get pacingEnabled() {
                    return prefs().sections.pacing;
                  },
                  get resetCredits() {
                    return state().main?.resetCredits;
                  }
                }), _$createComponent(Show, {
                  get when() {
                    return prefs().sections.fallbackAccounts;
                  },
                  get children() {
                    return _$createComponent(For, {
                      get each() {
                        return enabledFallbacks();
                      },
                      children: fb => _$createComponent(AccountBlock, {
                        get theme() {
                          return theme();
                        },
                        get appearance() {
                          return prefs().appearance;
                        },
                        get name() {
                          return fb.label ?? fb.id;
                        },
                        get quota() {
                          return fb.quota;
                        },
                        get killed() {
                          return fb.killed;
                        },
                        get active() {
                          return sessionRouting().activeId === fb.id;
                        },
                        get pacingEnabled() {
                          return prefs().sections.pacing;
                        },
                        get resetCredits() {
                          return fb.resetCredits;
                        },
                        marginTop: 1
                      })
                    });
                  }
                })];
              }
            });
          }
        }), _$createComponent(Show, {
          get when() {
            return prefs().sections.routing;
          },
          get children() {
            return [_$createComponent(SectionHeader, {
              get theme() {
                return theme();
              },
              title: "Routing"
            }), _$createComponent(For, {
              get each() {
                return buildRoutingRowsForDisplay(state(), props.sessionId);
              },
              children: row => _$createComponent(StatRow, {
                get theme() {
                  return theme();
                },
                get label() {
                  return row.label;
                },
                get value() {
                  return row.value;
                },
                get tone() {
                  return row.tone;
                }
              })
            })];
          }
        }), _$createComponent(For, {
          get each() {
            return getQuotaMetadataRows(state());
          },
          children: row => _$createComponent(StatRow, {
            get theme() {
              return theme();
            },
            get label() {
              return row.label;
            },
            get value() {
              return row.value;
            },
            tone: "text"
          })
        }), _$createComponent(Show, {
          get when() {
            return _$memo(() => !!degraded())() && prefs().sections.health;
          },
          get children() {
            return [_$createComponent(SectionHeader, {
              get theme() {
                return theme();
              },
              title: "Health"
            }), _$createComponent(Show, {
              get when() {
                return quotaBackedOff();
              },
              get children() {
                return _$createComponent(StatRow, {
                  get theme() {
                    return theme();
                  },
                  label: "Quota API",
                  get value() {
                    return `backoff ${formatUntil(state().main?.quotaBackoffUntil)}`;
                  },
                  tone: "warn"
                });
              }
            }), _$createComponent(Show, {
              get when() {
                return refreshBackedOff();
              },
              get children() {
                return _$createComponent(StatRow, {
                  get theme() {
                    return theme();
                  },
                  label: "Token refresh",
                  get value() {
                    return `backoff ${formatUntil(state().main?.refreshBackoffUntil)}`;
                  },
                  tone: "warn"
                });
              }
            })];
          }
        }), _$createComponent(Show, {
          get when() {
            return killedNames().length > 0;
          },
          get children() {
            return _$createComponent(StatRow, {
              get theme() {
                return theme();
              },
              label: "Killswitch",
              get value() {
                return `${killedNames().join(', ')} blocked`;
              },
              tone: "err"
            });
          }
        })];
      }
    }), null);
    _$effect(_p$ => {
      var _v$16 = theme().borderActive,
        _v$17 = theme().accent,
        _v$18 = theme().background;
      _v$16 !== _p$.e && (_p$.e = _$setProp(_el$38, "borderColor", _v$16, _p$.e));
      _v$17 !== _p$.t && (_p$.t = _$setProp(_el$40, "backgroundColor", _v$17, _p$.t));
      _v$18 !== _p$.a && (_p$.a = _$setProp(_el$41, "fg", _v$18, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$38;
  })();
}
const tui = async api => {
  const root = await readTuiPreferencesFile();
  const controller = createSidebarController(resolveOpenaiAuthPrefs(root));
  api.slots.register({
    order: computeEffectiveOrder(root, PLUGIN_KEY, DEFAULT_SLOT_ORDER),
    slots: {
      sidebar_content(_ctx, props) {
        return _$createComponent(QuotaSidebar, {
          api: api,
          controller: controller,
          get sessionId() {
            return props.session_id;
          }
        });
      }
    }
  });
  if (!rpcPollStarted) {
    rpcPollStarted = true;
    const myPid = process.pid;
    const rpcDir = await resolveRpcDir(api.state.path.directory ?? '');
    const rpcClient = createRpcClient(rpcDir.dir, myPid, entry => {
      log.debug('rpc tui pid', {
        myPid,
        matchedPortFilePid: entry?.pid ?? null,
        rpcPort: entry?.port ?? null
      });
    });
    let lastNotificationId = 0;
    let rpcInFlight = false;
    setInterval(() => {
      if (rpcInFlight) return;
      const current = api.route.current;
      const resolved = typeof current === 'function' ? current() : current;
      const sessionId = resolved?.params?.sessionID;
      rpcInFlight = true;
      void rpcClient.pending(lastNotificationId, sessionId).then(messages => {
        for (const message of [...messages].sort((a, b) => a.id - b.id)) {
          lastNotificationId = Math.max(lastNotificationId, message.id);
          if (message.payload.command === 'openai-quota') {
            api.ui.dialog.setSize('xlarge');
            api.ui.dialog.replace(() => _$createComponent(QuotaDialogContent, {
              api: api,
              controller: controller,
              sessionId: sessionId
            }));
            continue;
          }
          openCommandDialog(api, message.payload, (command, args) => rpcClient.apply(buildApplyRequest(command, args, sessionId), command === 'openai-reset' ? 90_000 : undefined), sessionId);
        }
      }).catch(() => {}).finally(() => {
        rpcInFlight = false;
      });
    }, RPC_POLL_MS);
  }
};
const plugin = {
  id: ID,
  tui
};
export default plugin;