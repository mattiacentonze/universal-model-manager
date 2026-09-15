import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */

import { createLogger } from "../logger";
import { getCollapsedQuotaSummary, getSidebarState, resolveSessionSidebarRouting } from "../sidebar-state.js";
import { errorMessage } from "../util/error";
import { openUrl } from "../util/open-url";
const log = createLogger('rpc-tui');
export function buildCachekeepDialogOptions(payload) {
  const enabled = payload.knobs.enabled === true;
  const subagents = payload.knobs.subagents === true;
  const sustain = payload.knobs.sustain === true;
  const running = payload.knobs.running === true;
  const tracked = Number(payload.knobs.tracked ?? 0);
  const generatedAt = Number(payload.knobs.generatedAt ?? Date.now());
  const lastWarmAt = Number(payload.knobs.lastWarmAt ?? 0);
  const maxIdleWarmMs = Number(payload.knobs.maxIdleWarmMs ?? 60 * 60 * 1000);
  const maxSubagentIdleMs = Number(payload.knobs.maxSubagentIdleMs ?? 30 * 60 * 1000);
  const windowKnob = payload.knobs.window;
  const windowLabel = windowKnob ? `${String(windowKnob.startHour).padStart(2, '0')}-${String(windowKnob.endHour).padStart(2, '0')}` : 'always (no window)';
  const lastWarm = lastWarmAt ? `${Math.ceil((generatedAt - lastWarmAt) / 1000)}s ago` : 'none yet';
  const idleWindow = Math.round(maxIdleWarmMs / 60_000);
  const subIdleWindow = Math.round(maxSubagentIdleMs / 60_000);
  const statusParts = [enabled ? '● Enabled' : '○ Disabled', `timer ${running ? 'armed' : 'idle'}`, `${tracked} tracked`, `last warm ${lastWarm}`, `window ${windowLabel}`, `${idleWindow}m idle cap`, `sustain ${sustain ? 'on' : 'off'}`, `subagent idle ${subIdleWindow}m`].filter(part => part.length > 0);
  return [{
    title: statusParts.join(' | '),
    value: 'status',
    description: 'Current cachekeep state'
  }, {
    title: enabled ? 'Turn off' : 'Turn on',
    value: enabled ? 'off' : 'on',
    description: enabled ? 'Stop capturing and warming prompt-cache prefixes' : 'Persistently enable capture; the timer self-arms on request capture'
  }, {
    title: subagents ? 'Subagent warming: on' : 'Subagent warming: off',
    value: subagents ? 'subagents off' : 'subagents on',
    description: subagents ? `Warm subagent sessions (${subIdleWindow}m idle cap). Disable to skip subagents.` : `Skip subagent sessions. Enable to warm them too (${subIdleWindow}m idle cap).`
  }, {
    title: sustain ? 'Sustain main sessions: on' : 'Sustain main sessions: off',
    value: sustain ? 'sustain off' : 'sustain on',
    description: 'main-only, idle-cap only; the configured clock window still applies.'
  }, {
    title: windowKnob ? `Warm window: ${windowLabel}` : 'Set warm window…',
    value: 'set_window',
    description: windowKnob ? `Currently only warming between ${windowLabel} local hours — pick to change` : 'Restrict capture + warm to a clock-hour window, e.g. 9-18 or 22-6'
  }, {
    title: 'Clear warm window',
    value: 'clear_window',
    description: windowKnob ? 'Remove the clock-hour restriction — return to always-warm (within idle caps)' : 'No clock-hour window is currently set'
  }, {
    title: 'Refresh status',
    value: 'refresh',
    description: 'Re-read cachekeep status'
  }, {
    title: 'Close',
    value: 'close',
    description: 'Close this dialog'
  }];
}
function resetAccountOptions(payload) {
  const accounts = Array.isArray(payload.knobs.accounts) ? payload.knobs.accounts : [];
  return [...accounts.map(account => {
    const used = account.usedPercent === undefined ? 'quota unavailable' : `${account.usedPercent}%`;
    const counts = `${account.applicableAvailableCount === undefined ? '?' : account.applicableAvailableCount}/${account.availableCount ?? '?'}`;
    const status = account.eligible ? 'eligible' : account.reason ?? 'unavailable';
    const details = `${used} · ${counts}`;
    const shortDate = account.selectedCreditExpiresAt?.slice(0, 10) ?? 'unknown';
    return {
      title: `${account.label} — ${status}`,
      value: `account:${account.accountKey}`,
      description: account.eligible ? `${details} · exp ${shortDate}` : details
    };
  }), {
    title: 'Refresh',
    value: 'refresh',
    description: 'Re-check account quota and reset credits'
  }, {
    title: 'Close',
    value: 'close',
    description: 'Close this dialog'
  }];
}
function resetResultOptions(payload) {
  const accountKey = typeof payload.knobs.accountKey === 'string' ? payload.knobs.accountKey : undefined;
  const chatgptAccountId = typeof payload.knobs.chatgptAccountId === 'string' ? payload.knobs.chatgptAccountId : undefined;
  const code = typeof payload.knobs.code === 'string' ? payload.knobs.code : '';
  const retrySafe = (code === 'ambiguous' || code === 'http_error' || code === 'expired_unreconciled' || payload.knobs.stateWriteFailed === true) && typeof payload.knobs.retryGuidance === 'string' && accountKey !== undefined && chatgptAccountId !== undefined;
  return [{
    title: payload.text,
    value: 'result',
    description: 'Command result'
  }, ...(retrySafe ? [{
    title: 'Retry',
    value: 'retry',
    description: 'Reuse the bound request and credit identifiers for this uncertain outcome'
  }] : []), {
    title: 'Refresh',
    value: 'refresh',
    description: 'Re-check account quota and reset credits'
  }, {
    title: 'Close',
    value: 'close',
    description: 'Close this dialog'
  }];
}
function openResetDialog(api, payload, apply) {
  let applyGeneration = 0;
  const render = state => {
    const applyAndRender = args => {
      const generation = ++applyGeneration;
      log.debug('reset dialog apply', {
        args,
        generation
      });
      void apply('openai-reset', args).then(result => {
        log.debug('reset dialog apply result', {
          generation,
          currentGeneration: applyGeneration,
          stage: result.knobs?.stage,
          accountRows: Array.isArray(result.knobs?.accounts) ? result.knobs.accounts.length : undefined
        });
        if (generation !== applyGeneration) return;
        if (typeof result.knobs?.stage !== 'string') {
          render({
            command: 'openai-reset',
            text: 'The reset request is still completing or returned no result. Choose Refresh to check the current state — do NOT re-confirm.',
            knobs: {
              stage: 'result',
              code: 'unknown'
            }
          });
          return;
        }
        render({
          command: 'openai-reset',
          text: result.text,
          knobs: result.knobs
        });
      }).catch(error => {
        if (generation !== applyGeneration) return;
        log.warn('reset dialog apply rejected', {
          error: errorMessage(error)
        });
        render({
          command: 'openai-reset',
          text: 'Command failed — the plugin could not complete the request; the plugin log has details.',
          knobs: {
            stage: 'result',
            code: 'error'
          }
        });
      });
    };
    const stage = state.knobs.stage;
    log.debug('reset dialog render', {
      stage,
      accountRows: Array.isArray(state.knobs.accounts) ? state.knobs.accounts.length : undefined,
      knobKeys: Object.keys(state.knobs)
    });
    api.ui.dialog.setSize('xlarge');
    if (stage === 'confirm') {
      const preview = state.knobs.preview;
      const accountKey = preview?.accountKey;
      const chatgptAccountId = preview?.chatgptAccountId;
      const availableCount = preview?.availableCount ?? 'unknown';
      const DialogConfirm = api.ui.DialogConfirm;
      api.ui.dialog.replace(() => _$createComponent(DialogConfirm, {
        title: "Reset quota window",
        get message() {
          return `${state.text}\n\nThis SPENDS 1 of ${availableCount} reset credits — irreversible.\n\nChoose Reset to continue or Cancel to return.\n\nEnter = Cancel (host default). Press Tab then Enter to Reset.`;
        },
        onConfirm: () => {
          if (!accountKey || !chatgptAccountId) return;
          applyAndRender(`confirm ${encodeURIComponent(accountKey)} ${encodeURIComponent(chatgptAccountId)}`);
        },
        onCancel: () => applyAndRender('refresh')
      }));
      return;
    }
    const DialogSelect = api.ui.DialogSelect;
    const options = stage === 'result' ? resetResultOptions(state) : resetAccountOptions(state);
    api.ui.dialog.replace(() => _$createComponent(DialogSelect, {
      title: stage === 'result' ? 'OpenAI reset result' : 'OpenAI reset credits',
      options: options,
      onSelect: option => {
        if (option.disabled) return;
        if (option.value === 'result') return;
        if (option.value === 'close') {
          applyGeneration += 1;
          api.ui.dialog.clear();
          return;
        }
        if (option.value === 'refresh') {
          applyAndRender('refresh');
          return;
        }
        if (option.value === 'retry') {
          const accountKey = state.knobs.accountKey;
          const chatgptAccountId = state.knobs.chatgptAccountId;
          if (typeof accountKey !== 'string' || typeof chatgptAccountId !== 'string') {
            return;
          }
          applyAndRender(`retry ${encodeURIComponent(accountKey)} ${encodeURIComponent(chatgptAccountId)}`);
          return;
        }
        if (!option.value.startsWith('account:')) return;
        const accountKey = option.value.slice('account:'.length);
        applyAndRender(`select ${encodeURIComponent(accountKey)}`);
      }
    }));
  };
  render(payload);
}
function showText(api, text) {
  api.ui.dialog.setSize('xlarge');
  api.ui.dialog.replace(() => (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", 'column');
    _$setProp(_el$, "padding", 1);
    _$setProp(_el$, "width", '100%');
    _$insert(_el$2, text);
    return _el$;
  })());
}
function showSetCachekeepWindowPrompt(api, apply, state, render) {
  const DialogPrompt = api.ui.DialogPrompt;
  const knobWindow = state.knobs.window;
  const seed = knobWindow ? `${knobWindow.startHour}-${knobWindow.endHour}` : '';
  api.ui.dialog.setSize('xlarge');
  api.ui.dialog.replace(() => _$createComponent(DialogPrompt, {
    title: "Cachekeep warm window",
    description: () => (() => {
      var _el$3 = _$createElement("text");
      _$insert(_el$3, () => state.text);
      return _el$3;
    })(),
    placeholder: "HH-HH (e.g. 9-18 or 22-6)",
    value: seed,
    onConfirm: value => {
      const trimmed = value.trim();
      if (!trimmed) {
        render(state);
        return;
      }
      void apply('openai-cachekeep', trimmed).then(r => {
        api.ui.toast({
          message: r.text
        });
        render({
          command: 'openai-cachekeep',
          text: r.text,
          knobs: r.knobs
        });
      });
    },
    onCancel: () => render(state)
  }));
}
export function openCommandDialog(api, payload, apply, sessionId) {
  if (payload.command === 'openai-reset') {
    openResetDialog(api, payload, apply);
    return;
  }
  if (payload.command === 'openai-routing') {
    const current = payload.knobs.mode ?? 'main-first';
    const DialogSelect = api.ui.DialogSelect;
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => _$createComponent(DialogSelect, {
      title: "OpenAI routing",
      current: current,
      options: [{
        title: 'Main first',
        value: 'main-first',
        description: 'Use the main account until exhausted'
      }, {
        title: 'Fallback first',
        value: 'fallback-first',
        description: 'Prefer fallback accounts, preserve main'
      }, {
        title: 'Sticky balanced',
        value: 'sticky-balanced',
        description: 'Keep each session on one account while balancing new sessions'
      }, {
        title: "Reset this session's pin",
        value: 'reset',
        description: 'Unpin this session; the next request may still choose the same account'
      }],
      onSelect: option => {
        void apply('openai-routing', String(option.value)).then(r => {
          api.ui.toast({
            message: r.text
          });
          api.ui.dialog.clear();
        });
      }
    }));
    return;
  }
  if (payload.command === 'openai-dump') {
    const enabled = payload.knobs.enabled === true;
    const DialogConfirm = api.ui.DialogConfirm;
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => _$createComponent(DialogConfirm, {
      title: "OpenAI request dump",
      get message() {
        return `${payload.text}\n\n${enabled ? 'Disable' : 'Enable'} request dump?`;
      },
      onConfirm: () => {
        void apply('openai-dump', enabled ? 'off' : 'on').then(r => {
          api.ui.toast({
            message: r.text
          });
          api.ui.dialog.clear();
        });
      },
      onCancel: () => api.ui.dialog.clear()
    }));
    return;
  }
  if (payload.command === 'openai-killswitch') {
    const config = payload.knobs.config ?? {};
    const accountIds = payload.knobs.accountIds ?? [];
    const enabled = config.enabled === true;
    const readT = t => {
      const fh = t?.primary ?? t?.['5h'] ?? 5;
      const sd = t?.secondary ?? t?.['1w'] ?? 10;
      return {
        fh,
        sd
      };
    };
    const mainT = readT(config.main);
    const seedParts = [`main:${mainT.fh},${mainT.sd}`];
    for (const id of accountIds) {
      const t = readT(config.accounts?.[id] ?? config.main);
      seedParts.push(`${id}:${t.fh},${t.sd}`);
    }
    const seed = seedParts.join(' ');
    const openEdit = () => {
      const DialogPrompt = api.ui.DialogPrompt;
      api.ui.dialog.setSize('xlarge');
      api.ui.dialog.replace(() => _$createComponent(DialogPrompt, {
        title: "Killswitch thresholds",
        description: () => (() => {
          var _el$4 = _$createElement("text");
          _$insert(_el$4, () => payload.text);
          return _el$4;
        })(),
        placeholder: "main:5,10 work-alt:5,10",
        value: seed,
        onConfirm: value => {
          void apply('openai-killswitch', `set ${value.trim()}`).then(r => {
            api.ui.toast({
              message: r.text
            });
            api.ui.dialog.clear();
          });
        },
        onCancel: () => api.ui.dialog.clear()
      }));
    };
    const DialogSelect = api.ui.DialogSelect;
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => _$createComponent(DialogSelect, {
      title: "OpenAI killswitch",
      options: [{
        title: enabled ? 'Disable killswitch' : 'Enable killswitch',
        value: enabled ? 'off' : 'on',
        description: enabled ? 'Stop hard-blocking on low quota' : 'Hard-block requests when quota drops below thresholds'
      }, {
        title: 'Edit thresholds\u2026',
        value: 'edit',
        description: 'Set per-account primary,secondary cutoffs'
      }],
      onSelect: option => {
        if (option.value === 'edit') {
          openEdit();
          return;
        }
        void apply('openai-killswitch', String(option.value)).then(r => {
          api.ui.toast({
            message: r.text
          });
          api.ui.dialog.clear();
        });
      }
    }));
    return;
  }
  if (payload.command === 'openai-logging') {
    const current = payload.knobs.level ?? 'info';
    const levels = ['error', 'warn', 'info', 'debug', 'trace'];
    const DialogSelect = api.ui.DialogSelect;
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => _$createComponent(DialogSelect, {
      title: "OpenAI logging",
      current: current,
      get options() {
        return levels.map(level => ({
          title: level,
          value: level,
          description: level === current ? 'currently active' : `Set log level to ${level}`
        }));
      },
      onSelect: option => {
        void apply('openai-logging', String(option.value)).then(r => {
          api.ui.toast({
            message: r.text
          });
          api.ui.dialog.clear();
        });
      }
    }));
    return;
  }
  if (payload.command === 'openai-cachekeep') {
    const render = state => {
      const options = buildCachekeepDialogOptions(state);
      const DialogSelect = api.ui.DialogSelect;
      api.ui.dialog.setSize('xlarge');
      api.ui.dialog.replace(() => _$createComponent(DialogSelect, {
        title: "OpenAI cachekeep",
        current: "status",
        options: options,
        onSelect: option => {
          if (option.value === 'close') {
            api.ui.dialog.clear();
            return;
          }
          if (option.value === 'set_window') {
            showSetCachekeepWindowPrompt(api, apply, state, render);
            return;
          }
          if (option.value === 'clear_window') {
            // The option label is `clear_window`, but executeCachekeepCommand
            // matches on `window clear` — forward the canonical form or the
            // command falls through to the usage-text branch and the window
            // is never cleared.
            void apply('openai-cachekeep', 'window clear').then(r => {
              render({
                command: 'openai-cachekeep',
                text: r.text,
                knobs: r.knobs
              });
            });
            return;
          }
          const args = option.value === 'refresh' ? 'status' : String(option.value);
          void apply('openai-cachekeep', args).then(r => {
            render({
              command: 'openai-cachekeep',
              text: r.text,
              knobs: r.knobs
            });
          });
        }
      }));
    };
    render(payload);
    return;
  }
  if (payload.command === 'openai-account') {
    openAccountDialog(api, apply, sessionId);
    return;
  }

  // fallback for quota (display-only)
  showText(api, payload.text);
}

// -- Accounts dialog ---------------------------------------------------------

export function formatQuotaWindows(quota) {
  const windowSummary = getCollapsedQuotaSummary(quota ?? null).text;
  if (windowSummary) return windowSummary;
  if (quota?.resetCreditsAvailable !== undefined) {
    return `resets: ${quota.resetCreditsAvailable}`;
  }
  return 'no quota data';
}
function osc52Copy(api, text) {
  try {
    const renderer = api.renderer;
    if (renderer && typeof renderer.copyToClipboardOSC52 === 'function') {
      return renderer.copyToClipboardOSC52(text);
    }
  } catch {
    // best-effort
  }
  return false;
}
export function buildAccountDialogRows(state, sessionId) {
  const activeId = resolveSessionSidebarRouting(state, sessionId).activeId;
  return [{
    title: `main${activeId === 'main' ? ' \u2022 active' : ''}`,
    value: 'main',
    description: formatQuotaWindows(state.main.quota)
  }, ...state.fallbacks.map(fb => ({
    title: `${fb.label ?? fb.id}${activeId === fb.id ? ' \u2022 active' : ''}${!fb.enabled ? ' (disabled)' : ''}`,
    value: fb.id,
    description: formatQuotaWindows(fb.quota)
  }))];
}
function openAccountDialog(api, apply, sessionId) {
  const DialogConfirm = api.ui.DialogConfirm;
  function showL1() {
    void getSidebarState().then(state => {
      const DialogSelectInner = api.ui.DialogSelect;
      api.ui.dialog.setSize('xlarge');
      api.ui.dialog.replace(() => _$createComponent(DialogSelectInner, {
        title: "OpenAI Accounts",
        get options() {
          return [...buildAccountDialogRows(state, sessionId), {
            title: 'Add account\u2026',
            value: '__add__',
            description: 'Sign in to a new OpenAI account'
          }];
        },
        onSelect: option => {
          if (option.value === '__add__') {
            showAddFlow();
            return;
          }
          // Main has no per-account actions: it is not removable or reorderable,
          // regardless of whether the active session uses mode or sticky routing.
          if (option.value === 'main') return;
          showL2Fallback(option.value);
        }
      }));
    });
  }
  function showL2Fallback(id) {
    void getSidebarState().then(state => {
      const DialogSelectInner = api.ui.DialogSelect;
      const fbIndex = state.fallbacks.findIndex(f => f.id === id);
      const fb = state.fallbacks[fbIndex];
      if (!fb) {
        showL1();
        return;
      }
      const options = [];
      options.push({
        title: 'Remove',
        value: 'remove',
        description: `Remove ${fb.label ?? fb.id}`
      });
      if (fbIndex > 0) {
        const neighbor = state.fallbacks[fbIndex - 1];
        if (neighbor) {
          options.push({
            title: 'Move up',
            value: 'move_up',
            description: `Swap with ${neighbor.label ?? neighbor.id}`
          });
        }
      }
      if (fbIndex < state.fallbacks.length - 1) {
        const neighbor = state.fallbacks[fbIndex + 1];
        if (neighbor) {
          options.push({
            title: 'Move down',
            value: 'move_down',
            description: `Swap with ${neighbor.label ?? neighbor.id}`
          });
        }
      }
      options.push({
        title: 'Back',
        value: 'back',
        description: 'Return to account list'
      });
      api.ui.dialog.setSize('xlarge');
      api.ui.dialog.replace(() => _$createComponent(DialogSelectInner, {
        get title() {
          return fb.label ?? fb.id;
        },
        options: options,
        onSelect: option => {
          if (option.value === 'remove') {
            api.ui.dialog.setSize('xlarge');
            api.ui.dialog.replace(() => _$createComponent(DialogConfirm, {
              title: "Remove account",
              get message() {
                return `Remove ${fb.label ?? fb.id}?`;
              },
              onConfirm: () => {
                void apply('openai-account', `remove ${id}`).then(r => {
                  api.ui.toast({
                    message: r.text
                  });
                  showL1();
                });
              },
              onCancel: () => showL2Fallback(id)
            }));
            return;
          }
          if (option.value === 'move_up') {
            const neighbor = state.fallbacks[fbIndex - 1];
            if (neighbor) {
              void apply('openai-account', `order ${id} ${neighbor.id}`).then(r => {
                api.ui.toast({
                  message: r.text
                });
                showL1();
              });
            }
            return;
          }
          if (option.value === 'move_down') {
            const neighbor = state.fallbacks[fbIndex + 1];
            if (neighbor) {
              void apply('openai-account', `order ${id} ${neighbor.id}`).then(r => {
                api.ui.toast({
                  message: r.text
                });
                showL1();
              });
            }
            return;
          }
          showL1();
        }
      }));
    });
  }

  // -- Add flow ---------------------------------------------------------------

  function showAddFlow() {
    const DialogSelectInner = api.ui.DialogSelect;
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => _$createComponent(DialogSelectInner, {
      title: "Add account",
      options: [{
        title: 'Browser sign-in (local)',
        value: 'browser',
        description: 'Opens a browser window for OAuth on this machine'
      }, {
        title: 'Device code (remote / no browser)',
        value: 'device',
        description: 'Enter a code on another device to authorize'
      }, {
        title: 'Back',
        value: 'back',
        description: 'Return to account list'
      }],
      onSelect: option => {
        if (option.value === 'browser') {
          showLabelPrompt('browser');
          return;
        }
        if (option.value === 'device') {
          showLabelPrompt('device');
          return;
        }
        showL1();
      }
    }));
  }
  function showLabelPrompt(mode) {
    const DialogPromptInner = api.ui.DialogPrompt;
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => _$createComponent(DialogPromptInner, {
      title: "Label (optional)",
      description: () => (() => {
        var _el$5 = _$createElement("text");
        _$insertNode(_el$5, _$createTextNode(`Give this account a name (e.g. "work", "personal"). Leave empty to auto-detect.`));
        return _el$5;
      })(),
      placeholder: "e.g. work",
      value: "",
      onConfirm: label => {
        if (mode === 'browser') {
          startBrowserAdd(label.trim() || undefined);
        } else {
          startDeviceAdd(label.trim() || undefined);
        }
      },
      onCancel: () => showAddFlow()
    }));
  }
  function startBrowserAdd(label) {
    const args = label ? `add ${label}` : 'add';
    void apply('openai-account', args).then(r => {
      const url = r.knobs.url;
      const instructions = r.knobs.instructions;
      if (!url) {
        api.ui.toast({
          message: 'Failed to get auth URL',
          variant: 'warning'
        });
        showL1();
        return;
      }

      // Auto-open the browser (best-effort)
      try {
        openUrl(url);
      } catch {
        // best-effort
      }
      showBrowserAuthScreen(url, instructions);
    });
  }
  function showBrowserAuthScreen(url, _instructions) {
    const DialogSelectInner = api.ui.DialogSelect;
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => _$createComponent(DialogSelectInner, {
      title: "Browser sign-in",
      options: [{
        title: 'Copy auth URL',
        value: 'copy_url',
        description: url
      }, {
        title: 'Open in browser',
        value: 'open',
        description: 'Try to open the URL in your browser'
      }, {
        title: "Done / I've authorized",
        value: 'done',
        description: 'Return to account list'
      }, {
        title: 'Cancel',
        value: 'cancel',
        description: 'Return to account list without adding'
      }],
      skipFilter: true,
      onSelect: option => {
        if (option.value === 'copy_url') {
          const ok = osc52Copy(api, url);
          api.ui.toast({
            message: ok ? 'Auth URL copied' : 'Copy unsupported — select the URL text manually',
            variant: ok ? 'success' : 'warning'
          });
          return;
        }
        if (option.value === 'open') {
          try {
            openUrl(url);
          } catch {
            // best-effort
          }
          return;
        }
        showL1();
      }
    }));
  }
  function startDeviceAdd(label) {
    const args = label ? `add --headless ${label}` : 'add --headless';
    void apply('openai-account', args).then(r => {
      const verificationUrl = r.knobs.verificationUrl;
      const userCode = r.knobs.userCode;
      const instructions = r.knobs.instructions;
      if (!verificationUrl) {
        api.ui.toast({
          message: 'Failed to get device code',
          variant: 'warning'
        });
        showL1();
        return;
      }
      showDeviceCodeScreen(verificationUrl, userCode, instructions);
    });
  }
  function showDeviceCodeScreen(verificationUrl, userCode, _instructions) {
    const DialogSelectInner = api.ui.DialogSelect;
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => _$createComponent(DialogSelectInner, {
      title: "Device code",
      options: [{
        title: userCode ? `Copy code: ${userCode}` : 'Copy code',
        value: 'copy_code',
        description: 'Copy the user code to clipboard'
      }, {
        title: 'Copy URL',
        value: 'copy_url',
        description: verificationUrl
      }, {
        title: "Done / I've authorized",
        value: 'done',
        description: 'Return to account list'
      }, {
        title: 'Cancel',
        value: 'cancel',
        description: 'Return to account list without adding'
      }],
      skipFilter: true,
      onSelect: option => {
        if (option.value === 'copy_code' && userCode) {
          const ok = osc52Copy(api, userCode);
          api.ui.toast({
            message: ok ? 'Code copied' : 'Copy unsupported — enter the code manually',
            variant: ok ? 'success' : 'warning'
          });
          return;
        }
        if (option.value === 'copy_url') {
          const ok = osc52Copy(api, verificationUrl);
          api.ui.toast({
            message: ok ? 'URL copied' : 'Copy unsupported — enter the URL manually',
            variant: ok ? 'success' : 'warning'
          });
          return;
        }
        showL1();
      }
    }));
  }
  void showL1();
}