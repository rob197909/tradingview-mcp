/**
 * Core alert logic.
 *
 * Alerts are created / listed / deleted through TradingView's pricealerts REST API
 * (https://pricealerts.tradingview.com) using the desktop app's authenticated session.
 * Requests are sent as text/plain so the browser does not issue a CORS preflight that
 * the endpoint rejects. The create/delete bodies must be wrapped in a `payload` object.
 */
import { evaluate, evaluateAsync, safeString, requireFinite } from '../connection.js';

// Map the tool's friendly condition names to TradingView's alert condition types.
const CONDITION_TYPE_MAP = {
  crossing: 'cross', cross: 'cross',
  greater_than: 'greater', greater: 'greater', above: 'greater', '>': 'greater',
  less_than: 'less', less: 'less', below: 'less', '<': 'less',
};

export async function create({ condition, price, message }) {
  const p = requireFinite(price, 'price');
  const condType = CONDITION_TYPE_MAP[String(condition || 'crossing').trim().toLowerCase()] || 'cross';

  return evaluate(`
    (function() {
      try {
        var ms = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
        var sym = (ms.proSymbol && ms.proSymbol()) || (ms.symbol && ms.symbol());
        if (!sym) return { success: false, error: 'Could not read current chart symbol from TradingView' };
        var price = ${JSON.stringify(p)};
        var condType = ${safeString(condType)};
        var msg = ${safeString(message || '')};
        if (!msg) {
          var verb = condType === 'greater' ? 'above' : (condType === 'less' ? 'below' : 'crossing');
          msg = sym.split(':').pop() + ' ' + verb + ' ' + price;
        }
        var cond = { type: condType, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: '1' };
        var payload = {
          conditions: [cond],
          symbol: '={"symbol":"' + sym + '"}',
          resolution: '1',
          message: msg,
          sound_file: 'alert/fired', sound_duration: 0,
          popup: true, auto_deactivate: true,
          email: false, sms_over_email: false, mobile_push: true,
          web_hook: null, name: null,
          expiration: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          active: true, ignore_warnings: true
        };
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, source: 'internal_api', symbol: sym, price: price, condition: condType, message: msg, alert_id: (data.r && data.r.alert_id) || null };
        }
        return { success: false, source: 'internal_api', error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + x.status), response: (x.responseText || '').slice(0, 200) };
      } catch (e) {
        return { success: false, source: 'internal_api', error: e.message };
      }
    })()
  `);
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all, alert_ids, alert_id } = {}) {
  // Resolve the set of alert ids to delete.
  let ids = [];
  if (Array.isArray(alert_ids)) ids = ids.concat(alert_ids);
  if (alert_id != null) ids.push(alert_id);
  if (delete_all) {
    const listed = await list();
    ids = (listed.alerts || []).map((a) => a.alert_id);
  }
  ids = ids.filter((x) => x != null);
  if (!ids.length) {
    return { success: false, source: 'internal_api', error: delete_all ? 'No alerts to delete.' : 'Provide delete_all: true or an alert_id to delete.' };
  }

  const result = await evaluate(`
    (function() {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/delete_alerts', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }));
        var data = {}; try { data = JSON.parse(x.responseText); } catch (e) {}
        return { ok: data.s === 'ok', status: x.status, response: (x.responseText || '').slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (result && result.ok) {
    return { success: true, source: 'internal_api', deleted_count: ids.length, alert_ids: ids };
  }
  return { success: false, source: 'internal_api', alert_ids: ids, error: (result && (result.error || result.response)) || 'delete failed' };
}

// ---------------------------------------------------------------------------
// Indicator-condition alerts: createStudyAlert / updateAlert.
//
// Payloads mirror what TradingView's own client sends (convertEditableAlertState
// plus active/ignore_warnings, TradingView Desktop 3.4.1). The study series is
// built from the live study's stateForAlert(), the symbol from the main series'
// getAlertSymbolString(). presentation_data is not sent: the server derives it.
// /modify_restart_alert always re-activates the alert; /stop_alerts and
// /restart_alerts toggle `active`.
// ---------------------------------------------------------------------------

const ALERTS_API = 'https://pricealerts.tradingview.com';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || evaluate,
    evaluateAsync: deps?.evaluateAsync || evaluateAsync,
  };
}

const STUDY_CONDITION_TYPES = ['cross_up', 'cross_down', 'cross', 'greater', 'less'];
const CONDITION_VERBS = { cross_up: 'crossing up', cross_down: 'crossing down', cross: 'crossing', greater: 'greater than', less: 'less than' };

// TradingView's Frequency enum is on_first_fire | on_bar_close | "60" (once per minute).
const FREQUENCY_MAP = new Map([
  ['on_bar_close', 'on_bar_close'],
  ['on_first_fire', 'on_first_fire'],
  ['once_per_minute', '60'],
]);

function studyConditionType(condition) {
  const c = String(condition ?? '').trim().toLowerCase();
  if (!STUDY_CONDITION_TYPES.includes(c)) {
    throw new Error(`condition must be one of ${STUDY_CONDITION_TYPES.join(', ')}, got: ${condition}`);
  }
  return c;
}

function frequencyValue(frequency) {
  const f = FREQUENCY_MAP.get(String(frequency ?? '').trim().toLowerCase());
  if (!f) throw new Error(`frequency must be one of ${[...FREQUENCY_MAP.keys()].join(', ')}, got: ${frequency}`);
  return f;
}

function requireValue(value, name) {
  if (value === null || value === undefined || value === '') throw new Error(`${name} is required`);
  return requireFinite(value, name);
}

// Alert resolutions are TradingView interval strings: "1", "60", "240", "1D", "1W", "1M".
function normalizeResolution(resolution) {
  const r = String(resolution ?? '').trim();
  if (/^[DWM]$/.test(r)) return '1' + r;
  if (/^\d+[SDWM]?$/.test(r)) return r;
  throw new Error(`resolution must look like "1", "60", "240", "1D", "1W" or "1M", got: ${resolution}`);
}

// plots are the study's alertable plots from stateForAlert(): [{ id, title, offset }].
function resolvePlot(plots, plot) {
  const want = String(plot ?? '').trim();
  const exact = plots.filter((p) => p.title === want);
  const matches = exact.length ? exact
    : plots.filter((p) => String(p.title).toLowerCase() === want.toLowerCase() || p.id === want);
  if (matches.length === 1) return matches[0];
  const available = plots.map((p) => `"${p.title}" (${p.id})`).join(', ') || 'none';
  if (matches.length > 1) throw new Error(`Plot "${plot}" is ambiguous on this study; pass the plot id instead. Alertable plots: ${available}`);
  throw new Error(`Plot "${plot}" is not an alertable plot of this study. Alertable plots: ${available}`);
}

// Pine alert inputs are the script's in_N inputs as plain values; stateForAlert() has { v, f, t }.
function pineAlertInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs || {})) {
    if (!/^in_\d+$/.test(k)) continue;
    out[k] = v !== null && typeof v === 'object' && 'v' in v ? v.v : v;
  }
  return out;
}

// Same shape alert_list returns for each alert.
function listShape(a) {
  let symbol = a.symbol;
  try { symbol = JSON.parse(String(a.symbol).replace(/^=/, '')).symbol || a.symbol; } catch { /* plain symbol */ }
  return {
    alert_id: a.alert_id,
    symbol,
    type: a.type,
    message: a.message,
    active: a.active,
    condition: a.condition,
    resolution: a.resolution,
    created: a.create_time,
    last_fired: a.last_fire_time,
    expiration: a.expiration,
  };
}

function readStudyForAlertJs(studyId) {
  return `
    (async function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var model = api._chartWidget.model().model();
      var chart = { symbol: api.symbol(), resolution: api.resolution(), alert_symbol: model.mainSeries().getAlertSymbolString() };
      var id = ${safeString(studyId)};
      var studies = api.getAllStudies();
      var onChart = studies.some(function(s) { return s.id === id; });
      var src = onChart && model.dataSources().find(function(s) { try { return s.id() === id; } catch (e) { return false; } });
      if (!src || !src.stateForAlertAsync) {
        return { found: false, chart: chart, studies: studies.map(function(s) { return s.id + ' (' + s.name + ')'; }) };
      }
      var name = '';
      try { name = src.metaInfo().description; } catch (e) {}
      if (!src.hasStateForAlert()) return { found: true, alertable: false, name: name, chart: chart };
      var st = await src.stateForAlertAsync();
      var inputs = {};
      Object.keys(st.inputs || {}).forEach(function(k) { if (k !== 'text') inputs[k] = st.inputs[k]; });
      return {
        found: true, alertable: true, name: name, chart: chart,
        is_pine: Boolean(st.isTVScript),
        pine_id: (st.inputs && st.inputs.pineId) || st.scriptIdPart || null,
        pine_version: (st.inputs && st.inputs.pineVersion) || st.scriptVersion || null,
        dependencies: (st.studyDependencies || []).map(function(d) { return d.study; }),
        plots: (st.plots || []).map(function(p) { return { id: p.id, title: p.title, offset: p.offset || 0 }; }),
        inputs: inputs
      };
    })()
  `;
}

// Finds studies on the current chart that an existing alert's study series refers to.
function findAlertStudyJs(series) {
  return `
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var want = ${JSON.stringify({ pine_id: series.pine_id || null, study: series.study || null })};
      var ids = api.getAllStudies().map(function(s) { return s.id; });
      var matches = [];
      api._chartWidget.model().model().dataSources().forEach(function(s) {
        try {
          if (ids.indexOf(s.id()) === -1 || !s.hasStateForAlert()) return;
          var st = s.stateForAlert();
          var pineId = (st.inputs && st.inputs.pineId) || st.scriptIdPart || null;
          var study = ((st.studyDependencies || [])[0] || {}).study || '';
          var same = want.pine_id ? pineId === want.pine_id : study.replace(/!$/, '') === want.study;
          if (same) matches.push({ id: s.id(), plots: (st.plots || []).map(function(p) { return p.id; }) });
        } catch (e) {}
      });
      return { symbol: api.symbol(), matches: matches };
    })()
  `;
}

// Same list_alerts call alert_list uses, returning one raw alert (minus presentation_data).
function fetchRawAlertJs(alertId) {
  return `
    fetch('${ALERTS_API}/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { error: data.errmsg || 'Unexpected response' };
        var a = data.r.find(function(x) { return x.alert_id === ${JSON.stringify(alertId)}; });
        if (!a) return { alert: null };
        var copy = Object.assign({}, a);
        delete copy.presentation_data;
        return { alert: copy };
      })
      .catch(function(e) { return { error: e.message }; })
  `;
}

function postAlertsApiJs(endpoint, payload) {
  return `
    (function() {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', ${safeString(ALERTS_API + endpoint)}, false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(${safeString(JSON.stringify({ payload }))});
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') return { ok: true, alert_id: (data.r && data.r.alert_id) || null };
        return { ok: false, error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + x.status), response: (x.responseText || '').slice(0, 300) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })()
  `;
}

async function fetchRawAlert(evaluateAsync, alertId) {
  const res = await evaluateAsync(fetchRawAlertJs(alertId));
  if (res?.error) throw new Error(`list_alerts failed: ${res.error}`);
  if (!res?.alert) throw new Error(`Alert ${alertId} not found`);
  return res.alert;
}

export async function createStudyAlert({ study_id, plot, condition, value, frequency = 'on_bar_close', resolution, message, dry_run = true, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  if (!study_id) throw new Error('study_id is required (entity id from chart_get_state)');
  const condType = studyConditionType(condition);
  const v = requireValue(value, 'value');
  const freq = frequencyValue(frequency);

  const info = await evaluateAsync(readStudyForAlertJs(study_id));
  if (!info?.found) {
    throw new Error(`Study ${study_id} is not on the current chart. Studies on chart: ${(info?.studies || []).join(', ') || 'none'}`);
  }
  if (!info.alertable) throw new Error(`TradingView does not currently allow alerts on study ${study_id} (${info.name}), e.g. in replay mode or if the study failed`);
  if (!info.is_pine || !info.pine_id) throw new Error(`Study ${study_id} (${info.name}) is not a Pine script; only Pine script studies are supported`);
  if (info.dependencies.length !== 1) throw new Error(`Study ${study_id} (${info.name}) takes its source from another study; such alerts are not supported`);
  const p = resolvePlot(info.plots, plot);
  const res = normalizeResolution(resolution ?? info.chart.resolution);

  const series = {
    type: 'study',
    study: info.dependencies[0].replace(/!$/, ''),
    plot_id: p.id,
    pine_id: info.pine_id,
    pine_version: info.pine_version,
    inputs: pineAlertInputs(info.inputs),
    offsets_by_plot: Object.fromEntries(info.plots.map((x) => [x.id, x.offset || 0])),
  };
  const payload = {
    conditions: [{ type: condType, frequency: freq, series: [series, { type: 'value', value: v }], resolution: res }],
    symbol: info.chart.alert_symbol,
    resolution: res,
    message: message || `${info.chart.symbol.split(':').pop()} ${p.title} ${CONDITION_VERBS[condType]} ${v}`,
    sound_file: 'alert/fired', sound_duration: 0, popup: true,
    // "Only once" alerts deactivate after firing; repeating ones stay active.
    auto_deactivate: freq === 'on_first_fire',
    email: false, sms_over_email: false, mobile_push: true,
    web_hook: null, name: null,
    expiration: null,
    active: true, ignore_warnings: true,
  };
  const summary = {
    study_id, study: info.name, plot: { id: p.id, title: p.title },
    condition: condType, value: v, frequency: freq, resolution: res, symbol: info.chart.symbol,
  };
  if (dry_run) return { success: true, source: 'internal_api', dry_run: true, ...summary, payload };

  const sent = await evaluate(postAlertsApiJs('/create_alert', payload));
  if (!sent?.ok) {
    return { success: false, source: 'internal_api', dry_run: false, ...summary, error: sent?.error || 'create failed', response: sent?.response };
  }
  return { success: true, source: 'internal_api', dry_run: false, alert_id: sent.alert_id, ...summary };
}

const MODIFY_FIELDS = ['condition', 'value', 'frequency', 'resolution', 'message'];

// Builds the requests that apply `patch` to a raw list_alerts alert, touching nothing else.
function planAlertUpdate(raw, patch) {
  const conditions = raw.conditions || [];
  if (conditions.length !== 1) throw new Error(`Alert ${raw.alert_id} has ${conditions.length} conditions; only single-condition alerts can be updated`);
  const cond = structuredClone(conditions[0]);
  // list_alerts echoes cross_interval, but TradingView's client does not send it back.
  delete cond.cross_interval;
  const changes = [];
  const note = (field, from, to) => changes.push({ field, from, to });

  if (patch.condition !== undefined) {
    const t = studyConditionType(patch.condition);
    if (!STUDY_CONDITION_TYPES.includes(cond.type)) {
      throw new Error(`condition can only be changed on ${STUDY_CONDITION_TYPES.join('/')} alerts; alert ${raw.alert_id} is "${cond.type}"`);
    }
    note('condition', cond.type, t);
    cond.type = t;
  }
  if (patch.value !== undefined) {
    const vs = (cond.series || []).find((s) => s?.type === 'value');
    if (!vs) throw new Error(`Alert ${raw.alert_id} does not compare against a fixed value, so it has no value to change`);
    const v = requireValue(patch.value, 'value');
    note('value', vs.value, v);
    vs.value = v;
  }
  let autoDeactivate = raw.auto_deactivate;
  if (patch.frequency !== undefined) {
    if (!('frequency' in cond)) throw new Error(`Alert ${raw.alert_id} (${cond.type}) has no trigger frequency`);
    const f = frequencyValue(patch.frequency);
    note('frequency', cond.frequency, f);
    cond.frequency = f;
    autoDeactivate = f === 'on_first_fire';
    if (autoDeactivate !== raw.auto_deactivate) note('auto_deactivate', raw.auto_deactivate, autoDeactivate);
  }
  let resolution = raw.resolution;
  if (patch.resolution !== undefined) {
    resolution = normalizeResolution(patch.resolution);
    note('resolution', raw.resolution, resolution);
    cond.resolution = resolution;
  }
  let message = raw.message;
  if (patch.message !== undefined) {
    message = String(patch.message);
    note('message', raw.message, message);
  }
  const wantActive = patch.active === undefined ? raw.active : Boolean(patch.active);
  if (patch.active !== undefined) note('active', raw.active, wantActive);

  const requests = [];
  const ids = { alert_ids: [raw.alert_id] };
  if (MODIFY_FIELDS.some((k) => patch[k] !== undefined)) {
    requests.push({
      endpoint: '/modify_restart_alert',
      payload: {
        conditions: [cond],
        symbol: raw.symbol,
        resolution,
        message,
        sound_file: raw.sound_file, sound_duration: raw.sound_duration, popup: raw.popup,
        auto_deactivate: autoDeactivate,
        email: raw.email, sms_over_email: raw.sms_over_email, mobile_push: raw.mobile_push,
        web_hook: raw.web_hook, name: raw.name,
        expiration: raw.expiration ?? null,
        ...(raw.notification_schedule ? { notification_schedule: raw.notification_schedule } : {}),
        active: true, ignore_warnings: true,
        alert_id: raw.alert_id,
      },
    });
    // modify_restart_alert always re-activates; stop the alert again if it should stay inactive.
    if (!wantActive) requests.push({ endpoint: '/stop_alerts', payload: ids });
  } else if (wantActive !== raw.active) {
    requests.push({ endpoint: wantActive ? '/restart_alerts' : '/stop_alerts', payload: ids });
  }
  return { changes, requests };
}

export async function updateAlert({ alert_id, condition, value, frequency, resolution, message, active, dry_run = true, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const id = requireValue(alert_id, 'alert_id');
  const patch = { condition, value, frequency, resolution, message, active };
  if (![...MODIFY_FIELDS, 'active'].some((k) => patch[k] !== undefined)) {
    throw new Error(`Nothing to update: supply at least one of ${[...MODIFY_FIELDS, 'active'].join(', ')}`);
  }

  const raw = await fetchRawAlert(evaluateAsync, id);
  const studySeries = (raw.conditions?.[0]?.series || []).find((s) => s?.type === 'study');
  if (studySeries) {
    const found = await evaluate(findAlertStudyJs(studySeries));
    const matches = found?.matches || [];
    if (!matches.length) {
      throw new Error(`The study of alert ${id} (${studySeries.pine_id || studySeries.study}) is not on the current chart`);
    }
    if (studySeries.plot_id && !matches.some((m) => m.plots.includes(studySeries.plot_id))) {
      throw new Error(`Plot ${studySeries.plot_id} of alert ${id} is not an alertable plot of that study on the current chart`);
    }
  }

  const { changes, requests } = planAlertUpdate(raw, patch);
  const before = listShape(raw);
  if (dry_run) return { success: true, source: 'internal_api', dry_run: true, alert_id: id, changes, before, requests };

  for (const req of requests) {
    const r = await evaluate(postAlertsApiJs(req.endpoint, req.payload));
    if (!r?.ok) {
      return { success: false, source: 'internal_api', dry_run: false, alert_id: id, changes, before, failed_request: req.endpoint, error: r?.error || 'request failed', response: r?.response };
    }
  }
  let after = null, after_error;
  try { after = listShape(await fetchRawAlert(evaluateAsync, id)); } catch (e) { after_error = e.message; }
  return { success: true, source: 'internal_api', dry_run: false, alert_id: id, changes, before, after, ...(after_error ? { after_error } : {}) };
}
