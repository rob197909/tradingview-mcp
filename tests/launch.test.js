/**
 * Tests for launch() in src/core/health.js.
 * Covers Windows MSIX handling: direct WindowsApps spawn, local-copy fallback
 * when spawn fails or CDP never binds, copy reuse, and classic-path launches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launch } from '../src/core/health.js';

const MSIX_EXE = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe';
const LOCAL_COPY_EXE = `${process.env.LOCALAPPDATA || ''}\\tradingview-mcp\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe`;
const CDP_VERSION = JSON.stringify({ Browser: 'Chrome/140', 'User-Agent': 'TVDesktop/3.1.0' });

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockChild({ failWith } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  if (failWith) queueMicrotask(() => child.emit('error', Object.assign(new Error(failWith), { code: failWith })));
  return child;
}

/**
 * Build a _deps bundle simulating a win32 MSIX environment.
 * @param {object} opts
 *   spawnFailures — spawn paths (substring) that emit EACCES
 *   cdpBindsFor  — spawn paths (substring) after which probeCdp starts succeeding
 *   copyExists   — local copy already present
 */
function msixDeps({ spawnFailures = [], cdpBindsFor = [], copyExists = false } = {}) {
  const state = { spawned: [], copies: [], removed: [], killed: 0, cdpUp: false };
  const deps = {
    existsSync: (p) => {
      if (p === MSIX_EXE) return true;
      if (p.includes('tradingview-mcp')) return copyExists || state.copies.length > 0;
      return false;
    },
    execSync: (cmd) => {
      if (cmd.includes('Get-AppxPackage')) {
        return 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\n';
      }
      if (cmd.includes('taskkill')) { state.killed++; return ''; }
      throw new Error(`unexpected execSync: ${cmd}`);
    },
    spawn: (exe) => {
      state.spawned.push(exe);
      const fail = spawnFailures.some((s) => exe.includes(s));
      if (!fail && cdpBindsFor.some((s) => exe.includes(s))) state.cdpUp = true;
      return mockChild(fail ? { failWith: 'EACCES' } : {});
    },
    cpSync: (src, dst) => { state.copies.push({ src, dst }); },
    rmSync: (p) => { state.removed.push(p); },
    readdirSync: () => ['TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj'],
    delay: async () => {},
    probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
  };
  return { deps, state };
}

// launch() only takes the MSIX code path on win32; skip elsewhere.
const onWindows = process.platform === 'win32';

describe('launch() — MSIX WindowsApps handling', { skip: !onWindows }, () => {
  it('direct WindowsApps spawn that binds CDP does not copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['WindowsApps'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, MSIX_EXE);
    assert.equal(result.msix_local_copy, undefined);
    assert.equal(state.copies.length, 0);
    assert.equal(result.cdp_url, 'http://127.0.0.1:9222');
  });

  it('EACCES on direct spawn falls back to local copy', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(result.binary, LOCAL_COPY_EXE);
    assert.equal(state.copies.length, 1);
    assert.match(state.copies[0].src, /WindowsApps/);
    // stale cached version of another release is cleaned up first
    assert.equal(state.removed.length, 1);
    assert.match(state.removed[0], /3\.0\.0\.7652/);
    // the CDP-less direct instance is killed before relaunching from the copy
    assert.ok(state.killed >= 2);
  });

  it('CDP never binding on direct spawn falls back to local copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.spawned.length, 2);
    assert.match(state.spawned[0], /WindowsApps/);
    assert.match(state.spawned[1], /tradingview-mcp/);
  });

  it('reuses an existing local copy without re-copying', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'], copyExists: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.copies.length, 0);
  });

  it('strips ELECTRON_RUN_AS_NODE from every spawned env (direct and copy fallback)', async () => {
    const saved = { run: process.env.ELECTRON_RUN_AS_NODE, sentinel: process.env.TV_LAUNCH_TEST_SENTINEL };
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.TV_LAUNCH_TEST_SENTINEL = 'kept';
    try {
      // Direct spawn never binds CDP, so launch() spawns twice: WindowsApps, then the local copy.
      const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'] });
      const envs = [];
      const spawnMock = deps.spawn;
      deps.spawn = (exe, args, opts) => { envs.push(opts?.env); return spawnMock(exe, args, opts); };
      await launch({ _deps: deps });
      assert.equal(state.spawned.length, 2);
      for (const env of envs) {
        assert.ok(env, 'spawn received an explicit env');
        assert.ok(!Object.keys(env).some((k) => k.toUpperCase() === 'ELECTRON_RUN_AS_NODE'));
        assert.equal(env.TV_LAUNCH_TEST_SENTINEL, 'kept', 'rest of process.env is passed through');
      }
      assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1', 'process.env itself is not mutated');
    } finally {
      if (saved.run === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved.run;
      if (saved.sentinel === undefined) delete process.env.TV_LAUNCH_TEST_SENTINEL; else process.env.TV_LAUNCH_TEST_SENTINEL = saved.sentinel;
    }
  });

  it('returns cdp_ready:false warning when nothing binds', async () => {
    const { deps } = msixDeps({});
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_ready, false);
    assert.equal(result.msix_local_copy, true);
    assert.ok(result.warning);
  });
});

describe('launch() — classic install path', { skip: !onWindows }, () => {
  it('launches classic LOCALAPPDATA install without MSIX logic', async () => {
    const classicExe = `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`;
    const state = { spawned: [], cdpUp: false };
    const deps = {
      existsSync: (p) => p === classicExe,
      execSync: (cmd) => { if (cmd.includes('taskkill')) return ''; throw new Error(`unexpected: ${cmd}`); },
      spawn: (exe) => { state.spawned.push(exe); state.cdpUp = true; return mockChild(); },
      cpSync: () => { throw new Error('should not copy'); },
      rmSync: () => {},
      readdirSync: () => [],
      delay: async () => {},
      probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
    };
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, classicExe);
    assert.equal(result.msix_local_copy, undefined);
    assert.deepEqual(state.spawned, [classicExe]);
  });

  it('throws a helpful error when TradingView is not found', async () => {
    const deps = {
      existsSync: () => false,
      execSync: () => { throw new Error('not found'); },
      spawn: () => { throw new Error('should not spawn'); },
      cpSync: () => {}, rmSync: () => {}, readdirSync: () => [],
      delay: async () => {}, probeCdp: async () => null,
    };
    await assert.rejects(() => launch({ _deps: deps }), /TradingView not found/);
  });
});
