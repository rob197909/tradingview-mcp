# RECONCILE-2026-09-18 — why the running MCP server has no COM launcher

Read-only check. The only file written is this one. No checkout, merge, pull or stash was run.

**Short answer:** nothing is out of date. The branch, the working tree and the running process all match. The COM launcher was **never added to the MCP server**. Commit `e0fc030` put it only in the shell launcher scripts under `scripts/`. `tv_launch` is implemented in `src/core/health.js`, which hasn't changed since commit `f23eb1b` (2026-04-03), and it has no MSIX/Store branch.

Evidence that the running server is this checkout: two `node.exe` processes (PIDs 5884 and 13288, started 2026-09-18 15:17) both run `C:\Users\rob\Desktop\Apps\tradingview-mcp\src\server.js`. The `src/` files were last modified 2026-04-18, before those processes started, so the running code is the checked-out code.

---

## 1. Is `e0fc030` on the current branch?

**Yes. It is `HEAD`.** The branch is `fix/launch-script-msix` (`git branch -a -vv`). `git branch -a --contains e0fc030` lists only this local branch:
- **Not pushed.** The branch is "ahead of `fork/fix/launch-script-msix` by 1 commit", and the fork is still at `dc7f294`.
- **Not on `main` or `origin/main`** (`4795784`).

`git show --stat e0fc030` shows the commit touched only three files, none in `src/`:
```
TV_MCP_OVERVIEW.md            | 638 +++
scripts/launch_msix_debug.ps1 |  87 +++
scripts/launch_tv_debug.bat   |  42 +--
```

## 2. Does the checked-out `src/server.js` contain the COM-activation launch path?

**Absent.**
- `src/server.js` (95 lines) contains no launch code. It imports and registers tool groups (`src/server.js:3,73`). `tv_launch` appears only in the instructions text at `src/server.js:59`.
- `tv_launch` is registered at `src/tools/health.js:21-27` and calls `core.launch()`, which is `launch()` at `src/core/health.js:162-251`. It contains no `IApplicationActivationManager`, `ActivateApplication`, `Get-AppxPackage`, `WindowsApps`, or call to either script. Nothing under `src/` matches any of those strings.
- The COM path exists only in `scripts/launch_msix_debug.ps1`: class `TVLauncher` with the `IApplicationActivationManager` interop at `:30-56`, method `TVLauncher.Launch()` at `:48-54` (calls `ActivateApplication` at `:51`), and the call site at `:64`.

## 3. What produced the 2026-09-18 `tv_launch` failure, and is it the only path?

**Code path:** `src/tools/health.js:25` → `launch()` in `src/core/health.js`:
1. `:172-176`: the win32 candidate list is exactly `%LOCALAPPDATA%\TradingView\TradingView.exe`, `%PROGRAMFILES%\TradingView\TradingView.exe` and `%PROGRAMFILES(X86)%\TradingView\TradingView.exe`. None exist, because the only Windows build is the Store/MSIX package under `WindowsApps` (`TV_MCP_OVERVIEW.md:505-507`).
2. `:188-190`: an existence check on each candidate. All miss.
3. `:192-198`: fallback to `where TradingView.exe`. A Store install isn't on PATH, and the error is swallowed silently at `:197`.
4. `:210-211`: throws `TradingView not found on win32. Searched: <the three paths>…`. This is the message seen today.

**Is it the only path?** **Within `tv_launch`, yes.** On win32 there is no other branch: the macOS `mdfind` fallback at `:200-208` is darwin-only, and nothing delegates to the scripts. The COM path is reachable only **outside** the MCP tool:
- `scripts/launch_tv_debug.bat:32-36` detects MSIX via `Get-AppxPackage`, and `:46-49` delegates to `scripts\launch_msix_debug.ps1`.
- The portfolio backend's `POST /api/tradingview/launch` runs that same `.bat` (`portfolio/backend/app/services/tradingview_service.py:46`).

This gap is already recorded as a confirmed bug in `TV_MCP_OVERVIEW.md:560-567` (§8 item 5), and at `:248` (§3) and `:500-502` (§7). `TV_MCP_OVERVIEW.md` §4 (indicator extraction, `:261-369`) doesn't cover launching.

The other launch branch, `origin/fix/tv-launch-electron38-compat` (`2261368`, not merged, forked from `main` on 2026-03-31), rewrites the same `launch()` for dependency injection. It keeps the same three win32 paths and also has no MSIX branch, so it wouldn't have fixed this either.

## 4. Does the working directory differ from `HEAD`?

**No.** `git status` reports "nothing to commit, working tree clean":
- no modified files
- no untracked files
- no uncommitted change to `src/server.js`, so the stop condition didn't apply

`git status --ignored` lists only `node_modules/` (ignored). This report will be the one untracked file.

## 5. Recommendation

**Nothing to check out or merge.** `HEAD` already has `e0fc030`, and the running server is this code. The fix is new code in `tv_launch`. A follow-up prompt should:
1. Change `launch()` in `src/core/health.js`. On win32, when the candidates and `where` both miss, detect the Store install (`Get-AppxPackage *TradingView*`) and run `scripts/launch_msix_debug.ps1 -Port <port>`, returning its exit code (0 = CDP up, 1 = launch failed, 2 = no CDP).
2. Allow about 120 s for the call. The current 15×1 s poll at `:225-245` is shorter than the 45–95 s MSIX cold start (`TV_MCP_OVERVIEW.md:526-527`).
3. Reconcile with `origin/fix/tv-launch-electron38-compat`, which rewrites the same function (dependency injection plus `tests/launch.test.js`), before writing new code.
4. Update `TV_MCP_OVERVIEW.md` §8 item 5.
5. Restart the MCP server processes so the change is loaded.
6. Separately, push `fix/launch-script-msix` to `fork` (still open in App Backlog).

Until then, launch TradingView with `scripts\launch_tv_debug.bat` or the portfolio app's TradingView launch endpoint, not `tv_launch`.

---

## Addendum — 2026-09-18, later: rebased onto upstream `main`

**This supersedes §5 above.** Upstream `main` (`c05b8f5`) already has what the follow-up was going to build. Its `launch()` finds the Store install via `Get-AppxPackage` (`src/core/health.js:317-328`) and has a local-copy fallback (`:367-381`, from `e2ef51e`). The electron38-compat commit (`2261368`) was never merged upstream.

### Branches
- **`c8b8dc2` dropped.** That merge of `origin/fix/tv-launch-electron38-compat` into `fix/launch-script-msix` was never pushed. It is kept reachable at **`backup/msix-merge-c8b8dc2`**. `fix/launch-script-msix` itself was left untouched (still at `c8b8dc2`); no branch was deleted.
- **New branch `msix-on-upstream`** = `origin/main` `c05b8f5` + `a32bb75`, a cherry-pick of `e0fc030` with these changes:
  - `scripts/launch_tv_debug.bat` conflicted, because upstream had changed it in `67280c2` and `e2ef51e`. Per Rob's rule ("if upstream's `launch()` works, take upstream's `.bat`"), it was resolved to **upstream's version**; it's identical to `origin/main`.
  - `scripts/launch_msix_debug.ps1` added as a **standalone manual fallback**. Nothing calls it automatically.
  - `TV_MCP_OVERVIEW.md` added and adapted to the new base: launch sections, configurable CDP host/port, a note that the `.ps1` is the fallback if the copy approach breaks, and a new §8.5 on `ELECTRON_RUN_AS_NODE`. Other `src/` references still describe `dc7f294`, which the header says.
- `src/` was not modified.

### Unit tests on `msix-on-upstream` (each file run on its own; no e2e)

| File | Result |
|---|---|
| `launch.test.js` | 7/7 pass |
| `replay.test.js` | 39/39 pass |
| `pine_analyze.test.js` | 16/16 pass |
| `sanitization.test.js` | 34/34 pass; the source-audit group doesn't run on Windows (`new URL(...).pathname` → `C:\C:\…`, ENOENT) |
| `cli.test.js` | 11/13; the 2 `pine check` tests fail because Node crashes on exit on Windows (libuv `src\win\async.c:76`, exit `0xC0000409`) |
| `chart_indicator.test.js` | 3/3 pass |
| `chart_history.test.js` | 4/4 pass |
| `update.test.js` | 9/9 pass (all git/npm calls mocked) |

### Live launch test (step 6)
Run with `TV_CDP_PORT=9223` through the CLI (`tv launch`, then `tv status` polled once a second, 120 s cap), because Chrome (PID 21908) holds 9222. TradingView was closed beforehand.

- **Run 1: failed, and the test itself was flawed.** The launching shell inherited `ELECTRON_RUN_AS_NODE=1` from the editor's extension host.
  - The direct `WindowsApps` start exited in under a second: AppModel-Runtime events 210/211/201 then 217 (container destroyed) at 21:16:01.
  - The fallback copied the package to `%LOCALAPPDATA%\tradingview-mcp\TradingView.Desktop_3.4.1.8194_x64__n534cwy3pjxzj` (118 files, 381.9 MB), and the copy exited too. Launching it with stderr captured showed: `TradingView.exe: bad option: --remote-debugging-port=9223`, which is Node's option parser.
  - `launch()` returned `cdp_ready: false, msix_local_copy: true` at 22.2 s. The port never opened within 120 s.
- **Run 2: passed via the direct path.** Same test with only `ELECTRON_RUN_AS_NODE` removed.
  - `binary` = `C:\Program Files\WindowsApps\TradingView.Desktop_3.4.1.8194_x64__n534cwy3pjxzj\TradingView.exe`, no `msix_local_copy`.
  - **Port open at 2.9 s**, `status` → `cdp_connected: true` at **3.9 s**, `launch()` returned at 5.2 s.
  - Build: TradingView 3.4.1, Electron 41.7.1, Chrome 146.
  - The saved layout "IBIT Tracking" (`/chart/GfFIJmr8/`, SPX 1M) loaded signed in, with `api_available: true`.
  - TradingView was left running (PID 24524, port 9223). The copy folder from run 1 was left in place.

### Open items
1. **`ELECTRON_RUN_AS_NODE` breaks `tv_launch`.** It fails on both the direct and copy paths whenever the calling process has the variable. The fix is one line in upstream `launch()`: remove it from the spawn `env` in `_spawnDetached` (`src/core/health.js:230-234`). That's a candidate issue or PR for upstream. Also check whether the MCP servers Claude Desktop starts inherit the variable; if they do, `tv_launch` fails in normal use. The `.ps1` is unaffected. Wiring the `.ps1` into the fallback would be a larger change (roughly 20 lines plus a test) and is not needed while the direct path works.
2. **The local-copy fallback probably starts signed out on this machine (inferred).** The Store build's profile is virtualized at `%LOCALAPPDATA%\Packages\TradingView.Desktop_n534cwy3pjxzj\LocalCache\Roaming\TradingView`. A copy without package identity would use `%APPDATA%\TradingView`, which doesn't exist. Not live-verified, because run 1's copy died before starting.
3. **Untested:** upstream's `.bat` path, and `launch_msix_debug.ps1` on 3.4.1.
4. **Superseded:** the July finding that a direct WindowsApps start never opens the port was wrong for 3.4.1 with a clean environment. It may have had the same `ELECTRON_RUN_AS_NODE` cause, but that isn't proven. `2261368`'s "Electron 38 rejects the flag" diagnosis fits the same symptom.

## Addendum 2 — 2026-09-18: `ELECTRON_RUN_AS_NODE` fix

Open item 1 is fixed in `5dbf956`. `_spawnDetached` (`src/core/health.js:230-246`) now gives TradingView a copy of `process.env` with `ELECTRON_RUN_AS_NODE` removed, covering both the direct and copy-fallback spawns, and `tests/launch.test.js` has a case that fails without the fix. The July finding that "the Store build ignores `--remote-debugging-port`" (`TV_MCP_OVERVIEW.md`, §7 history) was most likely this same bug. The July tests were driven from a Claude session (`e0fc030` is Claude-co-authored). If that session ran in the same VS Code-family editor as today's, its shell carried `ELECTRON_RUN_AS_NODE=1`, and the symptom matches exactly: the process exits at once and the port never opens. This is **unproven**, since 3.3.0 wasn't re-tested and the Store has since updated to 3.4.1. But from a clean environment the direct WindowsApps path reached `cdp_connected: true` in 3.9 s, so neither COM activation nor the local copy is needed for launching.

**Live check of `5dbf956` (21:43:56, `ELECTRON_RUN_AS_NODE=1` left set in the launching shell, `TV_CDP_PORT=9223`, 3.4.1.8194):** the direct WindowsApps path opened the port at 3.2 s and reached `cdp_connected: true` at 5.2 s. The copy fallback did not run (no `msix_local_copy`, one taskkill, copy folder untouched since 21:16:01), and TradingView was left running (PID 9332). Before the fix, the same conditions failed in run 1.
