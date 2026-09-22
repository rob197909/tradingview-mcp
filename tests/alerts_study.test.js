/**
 * Tests for indicator-condition alerts in src/core/alerts.js:
 * createStudyAlert (alert_create_study) and updateAlert (alert_update).
 * CDP is mocked via _deps; the study fixture mirrors what stateForAlert()
 * returns for the live "Implied Volatility Percentile" study (JJayFq).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStudyAlert, updateAlert } from '../src/core/alerts.js';

const PINE_ID = 'PUB;SUqQblSKh43f9kP01GIMkl2p5X4yLnjv';

// What the in-page study reader returns for JJayFq (the "text" IL blob is dropped in-page).
const STUDY_INFO = {
  found: true,
  alertable: true,
  name: 'Implied Volatility Percentile (IV Percentile, HVP) [Improved]',
  chart: { symbol: 'COINBASE:BTCUSD', resolution: '1M', alert_symbol: '={"currency-id":"USD","symbol":"COINBASE:BTCUSD"}' },
  is_pine: true,
  pine_id: PINE_ID,
  pine_version: '1.0',
  dependencies: ['Script@tv-scripting-101!'],
  plots: [
    { id: 'plot_0', title: 'volatility percentile', offset: 0 },
    { id: 'plot_1', title: 'moving average', offset: 0 },
  ],
  inputs: {
    pineId: PINE_ID,
    pineVersion: '1.0',
    in_0: { v: 30, f: true, t: 'integer' },
    in_1: { v: 5, f: true, t: 'integer' },
    in_2: { v: 30, f: true, t: 'integer' },
    in_3: { v: 'yes', f: true, t: 'text' },
    in_4: { v: 15, f: true, t: 'integer' },
    in_5: { v: 90, f: true, t: 'integer' },
  },
};

// Study series of reference alert 3683508800, as list_alerts returns it.
const REFERENCE_SERIES = {
  type: 'study',
  study: 'Script@tv-scripting-101',
  plot_id: 'plot_0',
  pine_id: PINE_ID,
  pine_version: '1.0',
  inputs: { in_0: 30, in_1: 5, in_2: 30, in_3: 'yes', in_4: 15, in_5: 90 },
  offsets_by_plot: { plot_0: 0, plot_1: 0 },
};

// A raw list_alerts entry shaped like the reference alert (fake id).
function rawAlert(overrides = {}) {
  const condition = {
    type: 'cross',
    frequency: 'on_bar_close',
    series: [structuredClone(REFERENCE_SERIES), { type: 'value', value: 70 }],
    cross_interval: false,
    resolution: '1D',
  };
  return {
    symbol: '={"symbol":"COINBASE:BTCUSD","adjustment":"splits","currency-id":"USD"}',
    resolution: '1D',
    condition,
    conditions: [structuredClone(condition)],
    expiration: null,
    auto_deactivate: false,
    expiration_policy: { time: null, policy: 'never' },
    email: true,
    sms_over_email: false,
    mobile_push: true,
    message: 'original message',
    sound_file: 'alert/fired',
    sound_duration: 0,
    popup: true,
    web_hook: null,
    name: 'Volatility Spike',
    alert_id: 4000000001,
    cross_interval: false,
    type: 'indicator',
    active: true,
    create_time: '2026-01-03T15:45:19Z',
    last_fire_time: null,
    last_fire_bar_time: null,
    last_error: null,
    last_stop_reason: null,
    complexity: 'complex',
    kinds: ['regular'],
    pro_symbol: '={"symbol":"COINBASE:BTCUSD","adjustment":"splits","currency-id":"USD"}',
    ...overrides,
  };
}

// Routes each evaluated expression to a canned response and records POSTs to the alerts API.
function mockCdp({ study = STUDY_INFO, alerts = [], chartMatches = [{ id: 'JJayFq', plots: ['plot_0', 'plot_1'] }] } = {}) {
  const store = new Map(alerts.map((a) => [a.alert_id, structuredClone(a)]));
  const posts = [];
  const handle = async (expr) => {
    if (expr.includes('stateForAlertAsync')) return structuredClone(study);
    if (expr.includes('/list_alerts')) {
      const id = Number(expr.match(/x\.alert_id === (\d+)/)[1]);
      return { alert: store.has(id) ? structuredClone(store.get(id)) : null };
    }
    if (expr.includes('x.send(')) {
      const endpoint = expr.match(/pricealerts\.tradingview\.com(\/\w+)/)[1];
      const body = JSON.parse(JSON.parse(expr.match(/x\.send\(("(?:[^"\\]|\\.)*")\)/)[1]));
      posts.push({ endpoint, payload: body.payload });
      if (endpoint === '/create_alert') return { ok: true, alert_id: 4000000099 };
      if (endpoint === '/modify_restart_alert') {
        const cur = store.get(body.payload.alert_id);
        store.set(cur.alert_id, { ...cur, message: body.payload.message, active: true });
      }
      if (endpoint === '/stop_alerts') for (const id of body.payload.alert_ids) store.set(id, { ...store.get(id), active: false });
      return { ok: true, alert_id: body.payload.alert_id ?? null };
    }
    if (expr.includes('matches.push')) return { symbol: 'COINBASE:BTCUSD', matches: structuredClone(chartMatches) };
    throw new Error('unexpected expression: ' + expr.slice(0, 120));
  };
  return { _deps: { evaluate: handle, evaluateAsync: handle }, posts, store };
}

const CROSS_UP_60 = { study_id: 'JJayFq', plot: 'volatility percentile', condition: 'cross_up', value: 60, frequency: 'on_bar_close', resolution: '1D', message: 'test' };

describe('createStudyAlert — payload construction', () => {
  it('builds a cross_up/60 payload whose study series reproduces the reference alert', async () => {
    const { _deps, posts } = mockCdp();
    const r = await createStudyAlert({ ...CROSS_UP_60, dry_run: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.dry_run, true);
    assert.equal(posts.length, 0, 'dry run must not send anything');
    assert.deepEqual(r.payload, {
      conditions: [{
        type: 'cross_up',
        frequency: 'on_bar_close',
        series: [REFERENCE_SERIES, { type: 'value', value: 60 }],
        resolution: '1D',
      }],
      symbol: '={"currency-id":"USD","symbol":"COINBASE:BTCUSD"}',
      resolution: '1D',
      message: 'test',
      sound_file: 'alert/fired', sound_duration: 0, popup: true,
      auto_deactivate: false,
      email: false, sms_over_email: false, mobile_push: true,
      web_hook: null, name: null,
      expiration: null,
      active: true, ignore_warnings: true,
    });
    assert.deepEqual(r.plot, { id: 'plot_0', title: 'volatility percentile' });
  });

  it('defaults to dry run when dry_run is omitted', async () => {
    const { _deps, posts } = mockCdp();
    const r = await createStudyAlert({ ...CROSS_UP_60, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(posts.length, 0);
  });

  it('with dry_run false sends exactly the dry-run payload and returns the new alert_id', async () => {
    const dry = await createStudyAlert({ ...CROSS_UP_60, _deps: mockCdp()._deps });
    const { _deps, posts } = mockCdp();
    const r = await createStudyAlert({ ...CROSS_UP_60, dry_run: false, _deps });
    assert.equal(r.success, true);
    assert.equal(r.alert_id, 4000000099);
    assert.deepEqual(posts, [{ endpoint: '/create_alert', payload: dry.payload }]);
  });

  it('uses the chart resolution when none is given, and maps once_per_minute to "60"', async () => {
    const { _deps } = mockCdp();
    const r = await createStudyAlert({ ...CROSS_UP_60, resolution: undefined, frequency: 'once_per_minute', _deps });
    assert.equal(r.payload.resolution, '1M');
    assert.equal(r.payload.conditions[0].resolution, '1M');
    assert.equal(r.payload.conditions[0].frequency, '60');
  });

  it('rejects frequency every_time (TradingView has no such frequency)', async () => {
    const { _deps, posts } = mockCdp();
    await assert.rejects(
      createStudyAlert({ ...CROSS_UP_60, frequency: 'every_time', dry_run: false, _deps }),
      /frequency must be one of on_bar_close, on_first_fire, once_per_minute, got: every_time/,
    );
    await assert.rejects(updateAlert({ alert_id: 4000000001, frequency: 'every_time', _deps: mockCdp({ alerts: [rawAlert()] })._deps }), /frequency must be one of/);
    assert.equal(posts.length, 0);
  });

  it('refuses a study that is not on the current chart', async () => {
    const { _deps, posts } = mockCdp({ study: { found: false, chart: STUDY_INFO.chart, studies: ['JJayFq (IV Percentile)'] } });
    await assert.rejects(createStudyAlert({ ...CROSS_UP_60, study_id: 'nope12', dry_run: false, _deps }), /not on the current chart/);
    assert.equal(posts.length, 0);
  });

  it('refuses a plot the study does not have, listing the alertable plots', async () => {
    const { _deps, posts } = mockCdp();
    await assert.rejects(
      createStudyAlert({ ...CROSS_UP_60, plot: 'Low volatility background indicator', dry_run: false, _deps }),
      /not an alertable plot.*"volatility percentile" \(plot_0\), "moving average" \(plot_1\)/,
    );
    assert.equal(posts.length, 0);
  });
});

describe('updateAlert — patching', () => {
  it('patches only the message (dry run)', async () => {
    const raw = rawAlert();
    const { _deps, posts } = mockCdp({ alerts: [raw] });
    const r = await updateAlert({ alert_id: raw.alert_id, message: 'test-updated', _deps });
    assert.equal(r.success, true);
    assert.equal(r.dry_run, true);
    assert.equal(posts.length, 0, 'dry run must not send anything');
    assert.deepEqual(r.changes, [{ field: 'message', from: 'original message', to: 'test-updated' }]);
    assert.equal(r.before.message, 'original message');

    const { cross_interval: _ci, ...condition } = raw.conditions[0];
    assert.deepEqual(r.requests, [{
      endpoint: '/modify_restart_alert',
      payload: {
        conditions: [condition],
        symbol: raw.symbol,
        resolution: raw.resolution,
        message: 'test-updated',
        sound_file: raw.sound_file, sound_duration: raw.sound_duration, popup: raw.popup,
        auto_deactivate: raw.auto_deactivate,
        email: raw.email, sms_over_email: raw.sms_over_email, mobile_push: raw.mobile_push,
        web_hook: raw.web_hook, name: raw.name,
        expiration: raw.expiration,
        active: true, ignore_warnings: true,
        alert_id: raw.alert_id,
      },
    }]);
  });

  it('with dry_run false sends the modify request and returns before/after', async () => {
    const raw = rawAlert();
    const { _deps, posts } = mockCdp({ alerts: [raw] });
    const r = await updateAlert({ alert_id: raw.alert_id, message: 'test-updated', dry_run: false, _deps });
    assert.equal(r.success, true);
    assert.deepEqual(posts.map((p) => p.endpoint), ['/modify_restart_alert']);
    assert.equal(r.before.message, 'original message');
    assert.equal(r.after.message, 'test-updated');
    assert.deepEqual(r.after.condition, r.before.condition);
  });

  it('keeps an inactive alert inactive after a message change', async () => {
    const raw = rawAlert({ active: false });
    const { _deps, posts, store } = mockCdp({ alerts: [raw] });
    await updateAlert({ alert_id: raw.alert_id, message: 'x', dry_run: false, _deps });
    assert.deepEqual(posts.map((p) => p.endpoint), ['/modify_restart_alert', '/stop_alerts']);
    assert.equal(store.get(raw.alert_id).active, false);
  });

  it('refuses when the alert\'s study is not on the current chart', async () => {
    const raw = rawAlert();
    const { _deps, posts } = mockCdp({ alerts: [raw], chartMatches: [] });
    await assert.rejects(updateAlert({ alert_id: raw.alert_id, message: 'x', dry_run: false, _deps }), /not on the current chart/);
    assert.equal(posts.length, 0);
  });

  it('refuses an unknown alert id and an empty patch', async () => {
    const { _deps } = mockCdp({ alerts: [rawAlert()] });
    await assert.rejects(updateAlert({ alert_id: 123, message: 'x', _deps }), /Alert 123 not found/);
    await assert.rejects(updateAlert({ alert_id: 4000000001, _deps }), /Nothing to update/);
  });
});
