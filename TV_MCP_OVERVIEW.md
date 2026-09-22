# TV_MCP_OVERVIEW

Read-only audit of the `tradingview-mcp` project. Every claim cites `path:line`. Items that
cannot be determined from source are marked **[UNVERIFIED]**. Nothing was launched, connected,
or executed to produce this document.

Repo root: `c:\Users\rob\Desktop\Apps\tradingview-mcp`. Audited at branch `fix/launch-script-msix`,
head commit `dc7f294`.

> **[2026-09-18] Rebased onto upstream `main` `c05b8f5`** (branch `msix-on-upstream`). The Windows
> launch material (§3 launch row, §7, §8 item 5) and the CDP host/port statements were updated for
> that base and for a live launch test run that day. All other `src/` line references and §8
> findings still describe `dc7f294` and have **not** been re-verified against upstream `main`.

---

## 1. WHAT THIS IS

`tradingview-mcp` is an unofficial Node.js bridge that drives a **live, already-running, logged-in
TradingView Desktop app** (an Electron program) over the **Chrome DevTools Protocol (CDP)** on
`127.0.0.1:9222` by default `[2026-09-18: was localhost, now configurable — §2]`, exposing chart reading and control both as an **MCP server** (stdio, for Claude
Code / any MCP client) and as a **`tv` CLI** that prints JSON to stdout (`package.json:5-9`,
`src/server.js:18-94`, `src/cli/index.js:1-31`). It does not use any official TradingView API or
data feed for the bulk of its work — it injects JavaScript into the running chart page and reads
TradingView's internal in-memory object model (`window.TradingViewApi...`) plus, where no model
path exists, scrapes the DOM (`src/connection.js:11-27`, `src/connection.js:106-121`). Its purpose
is AI-assisted chart analysis and Pine Script development: read the current symbol/timeframe,
indicator values, custom Pine drawings (lines/labels/tables/boxes), strategy backtest results, and
screenshots; and control the chart (change symbol/timeframe/type, add indicators, replay, draw,
alert). It is explicitly branded "Not affiliated with TradingView Inc. or Anthropic" and defers
compliance to the user (`src/server.js:89-90`, `SECURITY.md`, `README.md:14-15`).

✅ Section 1 complete.

---

## 2. ARCHITECTURE

### Language / runtime
- **Node.js 18+**, ES modules (`"type":"module"`, `package.json:4`; Node 18 requirement
  `README.md:51`). Two runtime dependencies only: `@modelcontextprotocol/sdk` and
  `chrome-remote-interface` (`package.json:21-24`). Zero-dependency CLI arg parsing via
  `node:util parseArgs` (`src/cli/router.js:5`).

### Layered layout
```
src/server.js      MCP entry — registers 14 tool groups over stdio
src/cli/index.js   CLI entry — registers 15 command groups, prints JSON
src/tools/*.js     MCP tool registrations (zod schemas) -> call core
src/cli/**/*.js    CLI command registrations -> call the SAME core
src/core/*.js      All business logic + injected page JS (the real engine)
src/connection.js  CDP connection, evaluate(), KNOWN_PATHS, safeString()
src/wait.js        chart-ready polling heuristics
scripts/*          OS launch scripts + Pine pull/push helpers
```
Both front-ends (MCP tools and CLI) are thin adapters over the shared `src/core/*` modules
(`src/core/index.js:5-16`). The programmatic entry `tradingview-mcp/core` re-exports only
`chart, data, pine, health, capture, drawing, replay, alerts, batch, watchlist, indicators, ui`
and **omits `stream`, `pane`, and `tab`** (`src/core/index.js:5-16`) — those three are reachable
only through the tool/CLI layers, not the public core API.

### How the CDP connection works
- `[2026-09-18, upstream main]` `CDP_HOST` defaults to `127.0.0.1` and `CDP_PORT` to `9222`, both
  overridable via `TV_CDP_HOST`/`TV_CDP_PORT` (or `CDP_HOST`/`CDP_PORT`) env vars
  (`src/connection.js:5-9`); `MAX_RETRIES=5`, `BASE_DELAY=500` (`:10-11`). (At `dc7f294` both were
  hardcoded to `localhost:9222`.)
- `connect()` fetches `http://<CDP_HOST>:<CDP_PORT>/json/list`, picks the page target whose URL matches
  `tradingview.com/chart` (falling back to any `tradingview` page), attaches via
  `chrome-remote-interface`, and enables `Runtime`, `Page`, `DOM` domains, with exponential backoff
  capped at 30 s (`src/connection.js:64-97`).
- `evaluate(expr)` runs `client.Runtime.evaluate({expression, returnByValue:true,
  awaitPromise:false})` and unwraps `result.result.value`; `evaluateAsync` sets `awaitPromise:true`
  (`src/connection.js:106-125`). Every capability is a JS snippet run in the page and returned as
  plain JSON.
- Injection safety: `safeString()` = `JSON.stringify(String(str))` to escape interpolated strings
  (`src/connection.js:36-38`); `requireFinite()` rejects NaN/Infinity before values reach APIs that
  persist to TradingView cloud state (`src/connection.js:44-48`). Known internal object paths are
  centralized in `KNOWN_PATHS` (`src/connection.js:11-27`).

### Entry points
- **MCP server:** `src/server.js` — `McpServer` + `StdioServerTransport`, name `tradingview`,
  version `2.0.0`; calls 14 `registerXxxTools(server)` functions (`src/server.js:1-94`). Startup
  disclaimer is written to **stderr** so it does not corrupt the stdio MCP protocol
  (`src/server.js:88-90`).
- **CLI:** `src/cli/index.js` — imports 15 command modules for their register side-effects, then
  `await run(process.argv)` (`src/cli/index.js:13-31`); binary name `tv` (`package.json:7-9`).

### Runs as an MCP server — 86 tools *(was 84 before the W1 alert tools below, 2026-09-22 — see
total-count note further down for a correction to this document's earlier 78/70/68 claims)*
All handlers share the shape `try { return jsonResult(await core.fn(args)); } catch (err) { return
jsonResult({success:false, error:err.message}, true); }` and emit **one pretty-printed-JSON text
block** via `jsonResult` (`src/tools/_format.js:5-10`). No zod schema uses `.default()`; documented
"default N" values are prose only and enforced downstream in core. Full inventory
(`name — params — file:line`):

**health.js (4)** `src/tools/health.js`
- `tv_health_check` — none — `:6`
- `tv_discover` — none — `:11`
- `tv_ui_state` — none — `:16`
- `tv_launch` — `port?` (coerce number), `kill_existing?` (coerce bool) — `:21-23`

**chart.js (10)** `src/tools/chart.js`
- `chart_get_state` — none — `:6`
- `chart_set_symbol` — `symbol` (string) — `:11`
- `chart_set_timeframe` — `timeframe` (string) — `:18`
- `chart_set_type` — `chart_type` (string; name or 0-9) — `:25`
- `chart_manage_indicator` — `action` (enum add|remove), `indicator` (string, full name), `entity_id?`, `inputs?` (JSON string) — `:32-36`
- `chart_get_visible_range` — none — `:42` *(broken at runtime, see §8)*
- `chart_set_visible_range` — `from` (coerce number), `to` (coerce number) — `:47-49`
- `chart_scroll_to_date` — `date` (string, ISO or unix) — `:55` *(broken at runtime, see §8)*
- `symbol_info` — none — `:62` *(broken at runtime, see §8)*
- `symbol_search` — `query` (string), `type?` — `:67-69`

**pine.js (12)** `src/tools/pine.js`
- `pine_get_source` `:6`, `pine_set_source` (`source`) `:11`, `pine_compile` `:18`, `pine_get_errors` `:23`,
  `pine_save` `:28`, `pine_get_console` `:33`, `pine_smart_compile` `:38`, `pine_new` (`type` enum
  indicator|strategy|library) `:43`, `pine_open` (`name`) `:50`, `pine_list_scripts` `:57`,
  `pine_analyze` (`source`, offline) `:62`, `pine_check` (`source`, server compile) `:69`.

**data.js (12)** `src/tools/data.js`
- `data_get_ohlcv` — `count?`, `summary?` — `:6`
- `data_get_indicator` — `entity_id` — `:14`
- `data_get_strategy_results` — none — `:21`
- `data_get_trades` — `max_trades?` — `:26`
- `data_get_equity` — none — `:33`
- `quote_get` — `symbol?` — `:38`
- `depth_get` — none — `:45`
- `data_get_pine_lines` — `study_filter?`, `verbose?` — `:50`
- `data_get_pine_labels` — `study_filter?`, `max_labels?`, `verbose?` — `:58`
- `data_get_pine_tables` — `study_filter?` — `:67`
- `data_get_pine_boxes` — `study_filter?`, `verbose?` — `:74`
- `data_get_study_values` — none — `:82`

**capture.js (1)** `src/tools/capture.js` — `capture_screenshot` — `region?`, `filename?`, `method?` (cdp|api) — `:6-9`

**drawing.js (5)** `src/tools/drawing.js` — `draw_shape` (`shape`, `point{time,price}`, `point2?`, `overrides?`, `text?`) `:6-11`,
`draw_list` `:17`, `draw_clear` `:22`, `draw_remove_one` (`entity_id`) `:27`, `draw_get_properties` (`entity_id`) `:34`.

**alerts.js (5)** `src/tools/alerts.js` — `alert_create` (`condition`, `price`, `message?`) `:6-9`, `alert_list` `:15`,
`alert_delete` (`delete_all?`) `:20`, `alert_create_study` (`study_id`, `plot`, `condition`, `value`, `frequency?`,
`resolution?`, `message?`, `dry_run?` default true) `:32-44` *(added W1 backlog, 2026-09-22)*, `alert_update`
(`alert_id`, `condition?`, `value?`, `frequency?`, `resolution?`, `message?`, `active?`, `dry_run?` default true)
`:46-58` *(added W1 backlog, 2026-09-22)*.

**batch.js (1)** `src/tools/batch.js` — `batch_run` — `symbols` (string[]), `timeframes?` (string[]), `action` (string), `delay_ms?`, `ohlcv_count?` — `:6-11`

**replay.js (6)** `src/tools/replay.js` — `replay_start` (`date?`) `:6`, `replay_step` `:13`, `replay_autoplay` (`speed?`) `:18`, `replay_stop` `:25`, `replay_trade` (`action` buy|sell|close) `:30`, `replay_status` `:37`.

**indicators.js (2)** `src/tools/indicators.js` — `indicator_set_inputs` (`entity_id`, `inputs` JSON string, **required**) `:6-8`, `indicator_toggle_visibility` (`entity_id`, `visible` bool) `:14-16`.

**watchlist.js (2)** `src/tools/watchlist.js` — `watchlist_get` `:6`, `watchlist_add` (`symbol`) `:11`.

**ui.js (12)** `src/tools/ui.js` — `ui_click` (`by` enum, `value`) `:6-8`, `ui_open_panel` (`panel` enum, `action` enum) `:14-16`,
`ui_fullscreen` `:22`, `layout_list` `:27`, `layout_switch` (`name`) `:32`, `ui_keyboard` (`key`, `modifiers?`) `:39-41`,
`ui_type_text` (`text`) `:47`, `ui_hover` (`by`, `value`) `:54-56`, `ui_scroll` (`direction` enum, `amount?`) `:62-64`,
`ui_mouse_click` (`x`, `y`, `button?`, `double_click?`) `:70-74`, `ui_find_element` (`query`, `strategy?`) `:80-82`,
`ui_evaluate` (`expression` — **arbitrary JS in page context**) `:88`.
Note: `layout_list`/`layout_switch` live in `ui.js`, not a `layout.js`.

**pane.js (4)** `src/tools/pane.js` — `pane_list` `:6`, `pane_set_layout` (`layout`) `:11`, `pane_focus` (`index`) `:18`, `pane_set_symbol` (`index`, `symbol`) `:25`.

**tab.js (4)** `src/tools/tab.js` — `tab_list` `:6`, `tab_new` `:11`, `tab_close` `:16`, `tab_switch` (`index`) `:21`.

**Total registered = 86** (health 4 + chart 10 + pine 12 + data 12 + capture 1 + drawing 5 +
alerts 5 + batch 1 + replay 6 + indicators 2 + watchlist 2 + ui 12 + pane 4 + tab 4), up from 84 with
`alert_create_study`/`alert_update` added 2026-09-22 (W1 backlog). **Correction to this document's
prior claim:** it previously said `src/server.js:25` and README claim 78 and `CLAUDE.md:1` claims 68
— live re-check (2026-09-22) shows `src/server.js:25`, README, and `CLAUDE.md:1` all already said
**84** before this change (updated independently of this document at some point after the 2026-09-18
rebase, never re-verified here until now). `src/cli/index.js:8` still says **70**. None of those three
docstrings were bumped to 86 by the W1 change — out of scope for that task, left for a future pass.
The count from the registration files, re-derived above, is authoritative.

Params typed as free-form `z.string()` (not enum), so out-of-range values are validated only in
core: `chart_set_type.chart_type`, `capture_screenshot.region`/`method`, `alert_create.condition`,
`batch_run.action`, `replay_trade.action`, `pane_set_layout.layout`. Custom response shapes deviate
in three tools (`tv_health_check` adds `hint` `health.js:8`, `depth_get` adds `hint` `data.js:47`,
`pine_open` adds `source:'internal_api'` `pine.js:54`); `watchlist_add` is the only tool with a
side-effecting error path (dispatches Escape via CDP, `watchlist.js:15-24`).

### Runs as a CLI — `tv`
Binary `tv` → `src/cli/index.js` (`package.json:7-9`). **stdout/exit-code contract**
(`src/cli/router.js`):
- Success: handler return value serialized with `JSON.stringify(result,null,2)` (pretty, multi-line)
  to **stdout**, `process.exit(0)` (`router.js:131-139`). Because exit is unconditional on return,
  a core "soft failure" `{success:false,...}` still prints to stdout with **exit 0** — callers must
  inspect `success`, not just the exit code.
- Thrown error: `{success:false,error}` JSON to **stderr**; exit **2** if the message matches
  `/CDP|connection|ECONNREFUSED|not running/i`, else exit **1** (`router.js:141-150`).
- Unknown command/subcommand: **plain text** (not JSON) to stderr, exit 1 (`router.js:64-68`,
  `:79-83`). Help text is plain text to stdout, exit 0 (`router.js:14-51`).
- `parseArgs` is called with `strict:false` + `allowPositionals:true`, so unknown flags (e.g.
  `--json`) are silently ignored. **There is no `--json` flag; output is unconditionally JSON.**

Command surface (flat commands + grouped subcommands). Flat: `tv status`, `tv launch [--port]
[--no-kill]`, `tv state`, `tv symbol [SYM]`, `tv timeframe [TF]`, `tv type [T]`, `tv info`,
`tv search <q>`, `tv range [--from --to]`, `tv scroll <date>`, `tv discover`, `tv ui-state`,
`tv quote [SYM]`, `tv ohlcv [-n -s]`, `tv values`, `tv screenshot [-r -o]`
(`src/cli/commands/{health,chart,data,capture}.js`). **Note:** basic chart ops are top-level —
the real command is `tv symbol AAPL`, **not** `tv chart symbol AAPL`; there is no `chart` command.
Grouped: `tv data <lines|labels|tables|boxes|strategy|trades|equity|depth|indicator>`,
`tv pine <get|set|compile|raw-compile|analyze|check|save|new|open|list|errors|console>`,
`tv replay <start|step|stop|status|autoplay|trade>`, `tv draw <shape|list|get|remove|clear>`,
`tv alert <list|create|delete>`, `tv watchlist <get|add>`, `tv layout <list|switch>`,
`tv indicator <add|remove|toggle|set|get>`, `tv ui <click|keyboard|hover|scroll|find|eval|type|panel|fullscreen|mouse>`,
`tv pane <list|layout|focus|symbol>`, `tv tab <list|new|close|switch>`, and `tv stream
<quote|bars|values|lines|labels|tables|all>` (all command files under `src/cli/commands/`).
`tv pine set|analyze|check` also read Pine source from **stdin** when `--file` is absent
(`src/cli/commands/pine.js:5-10`). `tv ui eval "<js>"` runs arbitrary JS in the page
(`src/cli/commands/ui.js:61-67`).

`tv stream <sub>` has a **different stdout contract**: it emits **NDJSON / JSONL** (one compact
single-line JSON object per change) to stdout indefinitely, each record augmented with `_ts`
(`Date.now()`) and `_stream` (label); dedup-on-change, logs/banner to stderr, runs until
SIGINT/SIGTERM then exits 0 (`src/core/stream.js:31-56`). The `all` sub uses label `all-panes` and
its records omit a top-level `symbol` (`src/core/stream.js:295-335`).

### Config files
- `package.json` — bin, exports, deps, npm `test`/`start` scripts (`package.json`).
- MCP registration is user-supplied JSON in `~/.claude/.mcp.json` (or project `.mcp.json`):
  `{"mcpServers":{"tradingview":{"command":"node","args":["<INSTALL_PATH>/src/server.js"]}}}`
  (`SETUP_GUIDE.md:16-32`, `README.md:118-131`). No `.env`, no in-repo runtime config file; all
  ports/paths/timeouts are hardcoded constants (see §8).

✅ Section 2 complete.

---

## 3. CAPABILITIES INVENTORY

Two mechanisms are used: the **internal `TradingViewApi` model** (robust, versioned JS object model)
and **fragile DOM/CDP-input automation** (`document.querySelector` on class-substring/`data-name`/
`aria-label` selectors + `Input.dispatchKeyEvent`/`dispatchMouseEvent`). Status = COMPLETE / PARTIAL
/ STUBBED / BROKEN.

| Capability | Core fn (file) | Mechanism | Status |
|---|---|---|---|
| Screenshot | `capture.captureScreenshot` (`core/capture.js:12`) | CDP `Page.captureScreenshot` → file; DOM clip for regions; `method:'api'` triggers TV's own screenshot | COMPLETE (region clip is fragile) |
| Set symbol | `chart.setSymbol` (`core/chart.js:40`) | model `chart.setSymbol` | COMPLETE |
| Set timeframe | `chart.setTimeframe` (`core/chart.js:55`) | model `chart.setResolution` | COMPLETE |
| Set chart type | `chart.setType` (`core/chart.js:67`) | model `chart.setChartType`, name→int 0-9 | COMPLETE |
| Set visible range | `chart.setVisibleRange` (`core/chart.js:128`) | model `timeScale.zoomToBarsRange` | COMPLETE |
| Get visible range | `chart.getVisibleRange` (`core/chart.js:118`) | model | **BROKEN** — bare `evaluate` (§8) |
| Scroll to date | `chart.scrollToDate` (`core/chart.js:160`) | model | **BROKEN** — bare `evaluate` (§8) |
| Symbol info | `chart.symbolInfo` (`core/chart.js:199`) | model `symbolExt` | **BROKEN** — bare `evaluate` (§8) |
| Symbol search | `chart.symbolSearch` (`core/chart.js:214`) | external REST `symbol-search.tradingview.com` | COMPLETE (not via CDP) |
| Add/remove indicator | `chart.manageIndicator` (`core/chart.js:87`) | model `createStudy`/`removeEntity`, ID-diff to report new id | COMPLETE (1500 ms add wait can false-negative) |
| Indicator inputs set | `indicators.setInputs` (`core/indicators.js:8`) | model `getInputValues`/`setInputValues` | COMPLETE |
| Indicator visibility | `indicators.toggleVisibility` (`core/indicators.js:40`) | model `setVisible`/`isVisible` | COMPLETE |
| Indicator inputs **get** | — | only embedded inside `setInputs`; no standalone reader | MISSING as standalone |
| Layout switch (saved cloud charts) | `ui.layoutList`/`ui.layoutSwitch` (`core/ui.js:104`,`:120`) | model `getSavedCharts`/`loadChartFromServer` + DOM dialog dismiss | COMPLETE (dialog dismiss fragile) |
| Replay (start/step/stop/status/autoplay/trade) | `replay.*` (`core/replay.js`) | model `_replayApi`; autoplay speed validated first | COMPLETE (most hardened module) |
| Alert create (price) | `alerts.create` (`core/alerts.js:18`) | REST `POST /create_alert`, `credentials:'include'`; `condition` mapped via `CONDITION_TYPE_MAP` and applied to the payload | COMPLETE — this doc's prior "`condition` param ignored / DOM + keyboard" claim (`alerts.js:72`) does not match current source; superseded, not re-audited further |
| Alert list | `alerts.list` (`core/alerts.js:66`) | REST `pricealerts.tradingview.com` `credentials:'include'` | COMPLETE |
| Alert delete | `alerts.deleteAlerts` (`core/alerts.js:97`) | REST `POST /delete_alerts` | COMPLETE — this doc's prior "opens context menu only / STUBBED" claim (`alerts.js:106-122`) does not match current source; superseded, not re-audited further |
| Alert create (indicator-condition) | `alerts.createStudyAlert` (`core/alerts.js`) *(added W1 backlog, 2026-09-22)* | REST `POST /create_alert`; study series (`pine_id`, `pine_version`, inputs, `plot_id`, `offsets_by_plot`) read live from the study's `stateForAlertAsync()`; `dry_run` default true | COMPLETE — live-verified 2026-09-22: dry-run payload for `JJayFq` (Implied Volatility Percentile) cross_up/60/on_bar_close/1D on COINBASE:BTCUSD byte-matched the corresponding fields of live reference alert 3683628369; `dry_run:false` created alert 5666009794, confirmed via `alert_list`, then deleted — see §8 |
| Alert update | `alerts.updateAlert` (`core/alerts.js`) *(added W1 backlog, 2026-09-22)* | REST `POST /modify_restart_alert` (+ `/stop_alerts` if patch keeps `active:false`); patches only supplied fields onto the alert fetched via the same call `alert_list` uses; requires the alert's study to be on the current chart; `dry_run` default true | COMPLETE — live-verified 2026-09-22: patched only `message` on alert 5666009794, condition/value/resolution unchanged per `alert_list` before/after |
| Batch multi-symbol | `batch.batchRun` (`core/batch.js:13`) | model `exportData` + CDP screenshot; `get_strategy_results` = DOM scrape | COMPLETE (1 fragile branch) |
| Panes / split-grid | `pane.*` (`core/pane.js`) | model `_chartWidgetCollection.setLayout` | COMPLETE — **not exported from core/index** |
| Tabs | `tab.*` (`core/tab.js`) | CDP `/json/list`,`/json/activate` + Ctrl+T/W keyboard | COMPLETE — **not exported** |
| Streaming | `stream.*` (`core/stream.js`) | model poll+diff → stdout JSONL | COMPLETE — **not exported**, CLI-only |
| UI clicks/keys/mouse/panels | `ui.*` (`core/ui.js`) | DOM selectors + CDP `Input` | COMPLETE (fragile by design) |
| Watchlist get/add | `watchlist.*` (`core/watchlist.js`) | pure DOM scraping/keyboard; no internal API; no remove | PARTIAL |
| Drawings | `drawing.*` (`core/drawing.js`) | model `createShape`/`getAllShapes`/`removeEntity` | COMPLETE |
| Health / discover / ui-state | `health.*` (`core/health.js`) | model + DOM | COMPLETE |
| Launch TradingView | `health.launch` (`core/health.js:286`) `[2026-09-18, upstream main]` | OS `spawn` + `/json/version` poll; MSIX/Store detection via `Get-AppxPackage` (`:317-328`) with a local-copy fallback (`:367-381`) | COMPLETE — live-verified 2026-09-18 via the direct path; breaks if `ELECTRON_RUN_AS_NODE` is inherited (§8) |
| Quote / OHLCV / study values / Pine graphics | `data.*` (`core/data.js`) | model (see §4) | COMPLETE |

**Robust (internal-model) capabilities:** symbol/timeframe/type, indicator add/remove + inputs +
visibility, drawings, replay, pane layout, chart-state/quote/OHLCV/study-value reads, alert
`list`/`create`/`delete`/`create_study`/`update` (all REST `pricealerts.tradingview.com`, not DOM —
correcting this doc's prior claim), layout `getSavedCharts`. **Fragile (DOM-dependent)
capabilities:** watchlist get/add, batch `get_strategy_results`, screenshot region clip, all `ui.*`,
`layout_switch` dialog dismissal, `pane.focus` (`_mainDiv`), `stream` graphics traversal,
`health.uiState` button scan.

✅ Section 3 complete.

---

## 4. INDICATOR EXTRACTION (critical section)

All extraction is in-page JS via `evaluate()` (`src/connection.js:106-121`) against the live chart.
There are **three distinct read paths**, none of which uses the official API:

### 4a. `data_get_study_values` — the Data Window projection
`getStudyValues()` (`src/core/data.js:324-358`): walk
`chart.model().model().dataSources()` (`:328-329`); for each source with `metaInfo`, take name =
`meta.description || meta.shortDescription` (skip if empty, `:335-336`); call `s.dataWindowView()`
`.items()` (`:340-342`) — the same data structure that backs TradingView's on-screen **Data
Window** — and keep `values[item._title] = item._value` where `_value` is truthy, not the null
glyph `∅`, and `_title` exists (`:346`). **Output shape:** `{success, study_count, studies:[{name,
values:{<plotTitle>:<value>}}]}`. Values are the **verbatim data-window strings** (no numeric
coercion), keyed by human-readable plot titles.

### 4b. `data_get_pine_lines / labels / tables / boxes` — Pine drawing primitives
All four use one builder `buildGraphicsJS(collectionName, mapKey, filter)`
(`src/core/data.js:11-60`). Traversal: `s._graphics._primitivesCollection[collectionName]
.get(mapKey).get(false)._primitivesDataById` — a Map of raw minified primitive records
(`:27-38`). This is exactly the path documented in `CLAUDE.md`. Mapping (`:362,:386,:406,:434`):

| Tool | collection / mapKey | Raw fields read | Output |
|---|---|---|---|
| `data_get_pine_lines` | `dwglines`/`lines` | `y1,y2` (+verbose `x1,x2,st,w,ci`) | horizontal levels where `y1===y2`, deduped, sorted desc (`:360-382`) |
| `data_get_pine_labels` | `dwglabels`/`labels` | `t` (text), `y` (price) (+verbose `x,yl,sz,tci,ci`) | `{text,price}`, capped to last `max_labels` (50) (`:384-402`) |
| `data_get_pine_tables` | `dwgtablecells`/`tableCells` | `tid,row,col,t` | re-gridded `tables[tid][row][col]`, rows joined with ` \| ` (`:404-430`) |
| `data_get_pine_boxes` | `dwgboxes`/`boxes` | `y1,y2`→`high/low` (+verbose `x1,x2,c,bc`) | deduped `{high,low}` zones sorted desc (`:432-454`) |

The `y1/y2/t/tid/...` keys are TradingView's internal minified primitive keys, read positionally
and never validated (`try/catch` yields empty on shape mismatch).

### 4c. `data_get_indicator` — input descriptors, blob-filtered
`getIndicator({entity_id})` (`src/core/data.js:109-133`): `api.getStudyById(id)` then
`study.getInputValues()` and `study.isVisible()` (`:113-117`). A **length heuristic**
(`:124-131`) drops any input with `id==='text'` and value >200 chars, and any string value >500
chars — i.e. it strips the large encoded blobs that protected/packaged scripts stuff into inputs.
It does **not** inspect any protection flag.

### Does invite-only / protected affect extraction?
**No code anywhere special-cases "protected", "encrypted", "invite-only", or "obfuscated"** (grep
returned only an unrelated HTTP header and `scriptIdPart` in the pine-facade source fetch,
`src/core/pine.js:196,:565,:600`). The reason 4a/4b keep working: an invite-only Pine script hides
only its **source text**; the compiled study still executes in-page and populates the **same**
internal model, Data Window, and drawing-primitive Maps as any open script. Protection hides the
*recipe*, not the *rendered output*. The only path that genuinely fails on protection is
`pine_get_source`/`pine_open`, which fetch source text from `pine-facade.tradingview.com` and error
`'Script source is empty'` for scripts you don't own (`src/core/pine.js:567-571`) — but that is
source, not values.

### The 8 InvestAnswers indicators
**None of them appear anywhere in this repo** (grep for `InvestAnswers, IADSS, LILO, PTOS, Arb,
DCAS, Mean Reversion, Optimized Trend, Macro Model, Confluence` returned only incidental substring
hits like `ljharb` in `package-lock.json` and "arbitrary" in a test). The extraction engine is
**fully generic** — it selects studies by `meta.description` name match + optional `study_filter`
substring and reads whatever fields are present. So extractability is **not** blocked by
invite-only status; it is gated entirely by **(1)** the indicator being added to the chart and
visible, and **(2)** whether the indicator surfaces the specific value as a Data-Window `plot()` or
as a `line.new`/`label.new`/`table.new`/`box.new` drawing. Values shown only via `fill()`,
`bgcolor()`, `linefill()`, or color-only `plotshape`/`plotchar` have **no numeric extraction path**
and would require a screenshot + OCR.

Classification below was initially inferred from each indicator's name. The **Observed results**
subsection that follows records live extraction (verified 2026-07-08 on a NASDAQ:META 1D chart,
TradingView 3.3.0.7992) and supersedes the inference: row 2 is now **VERIFIED**; the other seven were
**not on the test chart** and are marked **[pending]** until a layout switch brings them onto a chart.

| # | IA output | Mechanism → tool | Verdict |
|---|---|---|---|
| 1 | IADSS Confluence signal state | discrete signal → `label.new`/status `table` or a `plot` → `data_get_pine_labels` / `data_get_pine_tables` / `data_get_study_values` | **[pending]** — not on test chart; extractable if surfaced as label/table/plot, screenshot-only if a colored bar/shape |
| 2 | Optimized Trend direction | `plot()` — Fast & Slow plots in Data Window; direction = sign of (Fast − Slow); cloud is `fill()` (not a primitive) | **VERIFIED extractable** — live as `IA-Optimized-Trend [1.3]`: Fast 597.56 / Slow 587.04 ⇒ uptrend, via `data_get_study_values`. Cloud fill is screenshot-only |
| 3 | Mean Reversion score | numeric → `plot()` → `data_get_study_values` | **[pending]** — not on test chart; expected extractable as a plot |
| 4 | LILO layer prices | price levels → `line.new` → `data_get_pine_lines` (or `plot` → study values) | **[pending]** — not on test chart; expected extractable (lines and/or plots) |
| 5 | PTOS oscillator | sub-pane `plot()` → `data_get_study_values` | **[pending]** — not on test chart; layouts `IA PTOS *` exist, so reachable via `layout_switch` |
| 6 | Macro Model score | numeric → `plot()` or dashboard `table.new` → `data_get_study_values` / `data_get_pine_tables` | **[pending]** — not on test chart; expected extractable as plot/table |
| 7 | Arb Cloud bands | band edges → two `plot()`s (with `fill()` between) → `data_get_study_values` for the edge values | **[pending]** — not on test chart; layouts `IA ARB Cloud *` exist. Edge values expected extractable; cloud fill screenshot-only |
| 8 | DCAS zone | zone → `box.new` → `data_get_pine_boxes`, OR `bgcolor()`/`fill()` → not extractable | **[pending]** — not on test chart; extractable only if drawn as `box.new` |

#### Observed results — live extraction (2026-07-08, NASDAQ:META 1D, TradingView 3.3.0.7992)
Two IA studies were on the test chart; extracted via the MCP `data_*` path (the authoritative one — see divergence note):

| Study on chart | Mechanism(s) observed | Sample extracted values | Verdict |
|---|---|---|---|
| `IA-Optimized-Trend [1.3]` (one of the 8) | `plot` (Fast/Slow) + `fill` cloud | Fast Plot 597.56, Slow Plot 587.04 (⇒ uptrend) | extractable (plots); cloud screenshot-only |
| `IA Rotation Model [1.6]` (not one of the 8) | `plot` + `table` + `label` + `line` | Rotation In/Out 0.0000; table "Projections" (META $1.0K/$1.2K, ASTS, NET, TSLA, MSTR); table "Results" (HODL 88.7% vs Rotation 486.5%); 71 empty-text price-marker labels; 1 line; 0 boxes | extractable (values + tables + labels) |

Not present on the test chart (await `layout_switch`): IADSS Confluence, Mean Reversion, LILO, PTOS,
Macro Model, Arb Cloud, DCAS. Saved layouts include `IA PTOS *` (several) and `IA ARB Cloud *` (3), so
PTOS and Arb Cloud are reachable immediately; no saved layout is obviously named for IADSS / Mean
Reversion / LILO / Macro Model / DCAS.

**"Extractable with a profile or layout change":** there is no profile system (see §5), but
`layout_switch` can load a **saved TradingView cloud chart** that already contains these indicators
(`src/core/ui.js:120-141`). So if the user has a saved layout with the IA scripts applied, the
practical flow is: `layout_switch` (or `chart_manage_indicator add` if the script name resolves) →
ensure visible → `data_get_study_values` + the four `data_get_pine_*` tools filtered by name. The
one hard limit that no code change fixes: outputs rendered only through `fill`/`bgcolor` are invisible
to every value tool and are recoverable only from `capture_screenshot`.

**Divergence — RESOLVED (verified live 2026-07-08).** `src/core/stream.js` re-reads the same
graphics/values a **different way** — values from `study._study._lastBarValues || _data`
(`stream.js:132`), lines/labels from `points[].price`/`.text` (`stream.js:180-182,:225-226`) — vs
`data.js`'s Data-Window `_title/_value` and primitive `y1/y2/t/tid`. Run side-by-side on the same
chart, the **`data.js` convention is correct** (real plot values, 71 labels, 2 populated tables),
while the **`stream.js` convention is stale/broken** on build 3.3.0.7992: `tv stream values` returns
garbage keys `{"_start":0,"_end":400}`, and `tv stream lines` / `tv stream tables` return
`study_count: 0`. **Takeaway:** the MCP `data_get_*` tools (the `data.js` path) are authoritative;
`tv stream *` must be fixed before any daily job relies on it (tracked in §8).

✅ Section 4 complete.

---

## 5. CHART PROFILES

**There is no chart-"profile" (named preset/configuration) system in this repo.** Exhaustive grep
for `profile|preset|IADSS|InvestAnswers` (excluding `node_modules`) found only:
- `"Profiler"` — an **example indicator name** used as a `study_filter` value in docs and a param
  description, not a profile (`CLAUDE.md:20`, `README.md:197,:240`, `src/server.js:40`,
  `src/tools/data.js:51`).
- `-NoProfile` — a **PowerShell CLI flag** in the Windows launchers (`scripts/launch_tv_debug.bat:25`, `src/core/health.js:321`) `[2026-09-18: cites updated for upstream main]`.
- `IADSS`, `InvestAnswers` — **zero matches** anywhere in the repo.

No profile file, tool, CLI command, or core module exists. There is nothing with a ready/todo state
to enumerate, because the concept is absent. **If the portfolio app expects a "profile" abstraction,
it does not exist here and would have to be built.**

Two **layout** concepts exist (neither is a profile):

1. **Saved cloud charts — `layout_list` / `layout_switch` (DYNAMIC).** Reads the logged-in user's
   own saved charts live via `window.TradingViewApi.getSavedCharts(cb)` → `{id,name,symbol,
   resolution,modified}` and switches via `loadChartFromServer(id|matchedName)`
   (`src/core/ui.js:104-141`). The list is whatever the user has saved — **not** hardcoded, and
   **[UNVERIFIED]** at audit time (depends on the live account). Switching then auto-dismisses an
   "unsaved changes / open anyway / don't save / discard" dialog by button-text regex
   (`src/core/ui.js:143-160`).
2. **Multi-pane grids — `pane_set_layout` (HARDCODED enum).** `LAYOUT_NAMES` map with codes
   `s, 2h, 2v, 2-1, 1-2, 3h, 3v, 3s, 4, 4h, 4v, 4s, 6, 8, 10, 12, 14, 16` plus friendly aliases
   (`single/1/1x1→s`, `2x2/grid/quad→4`, …) (`src/core/pane.js:9-28,:86-92`), applied via
   `_chartWidgetCollection.setLayout(code)` (`:99`). The tool/CLI/README advertise only a subset
   "s, 2h, 2v, 4, 6, 8" (`src/tools/pane.js:11-12`, `src/server.js:60`) — the code supports 18.

✅ Section 5 complete.

---

## 6. INTEGRATION SURFACE

**There is no in-repo portfolio app, no HTTP server, no listening socket, and no IPC.** Grep for
`http.createServer|listen(|webhook|portfolio|handoff` in `src/` found nothing. The two other
working directories in this environment (`Multicare-ai-gigharbor-rebrand`, `wealthmanagement`) are
unrelated repos and are not referenced by any file here. An external app can integrate only via
three channels:

1. **MCP over stdio (primary).** `McpServer` + `StdioServerTransport` (`src/server.js:1-2,:93-94`);
   the client (Claude Code) spawns `node src/server.js` and speaks MCP over stdin/stdout. **No
   network port is opened by the server itself.** Returns one pretty-JSON text block per tool call
   (`src/tools/_format.js:5-10`).
2. **CLI stdout as JSON / JSONL (pipe-friendly).** Shell out to `tv <cmd>`; parse stdout.
   - One-shot commands: `JSON.parse(entireStdout)` (multi-line pretty JSON, shape
     `{success:boolean, ...}`). Must check `success`, not just exit code (soft failures exit 0 on
     stdout; hard errors are JSON on **stderr** with exit 1, or **exit 2** for connection errors;
     routing errors are plain text on stderr) (`src/cli/router.js:131-150`). No `--json` flag; format
     is fixed. Documented for `jq` piping (`README.md:139,:160`).
   - Streaming: `tv stream <sub>` writes **NDJSON to stdout** (one object per change, `_ts`+`_stream`
     injected, dedup-on-change), banner/errors to stderr, runs until SIGINT (`src/core/stream.js:
     25-56`). Parse **line-by-line**. Intended for monitoring dashboards (`README.md:184-199`).
3. **File-drop outputs.**
   - **Screenshots** → repo-relative `screenshots/` dir (`SCREENSHOT_DIR` in `src/core/capture.js:10`,
     duplicated `src/core/batch.js:11`), filenames `tv_<region>_<ISO-ts>.png`
     (`src/core/capture.js:15-17`); the tool returns `{file_path, size_bytes}` in its JSON, **not**
     image bytes (`src/core/capture.js:63-69`). `screenshots/` is git-ignored (`.gitignore:2`).
   - **Pine source handoff** via `scripts/pine_pull.js` / `scripts/pine_push.js`, which open their
     **own** CDP connection to `localhost:9222` (separate from the MCP server): `pine_pull` reads the
     Monaco editor value by walking the React fiber tree and writes `scripts/current.pine`; `pine_push`
     reads that file, injects it, clicks compile, waits 3000 ms, reads Monaco error markers
     (`scripts/pine_pull.js:6-21`, `scripts/pine_push.js:9-42`). `scripts/current.pine` is git-ignored.
   - **OHLCV export**: `batch_run action:'get_ohlcv'` uses the internal `exportData({includeTime,
     includeSeries, includeStudies:false})` capped at 500 bars (`src/core/batch.js:47-57`);
     `data_get_ohlcv` supports a compact `summary` mode (`src/core/data.js:62-107`).

**Assumptions a caller inherits:** CDP at `127.0.0.1:9222` unless `TV_CDP_PORT`/`TV_CDP_HOST` are
set — `tv_launch --port` alone does not move the connection layer; set the env var to match
`[2026-09-18, upstream main]`; a single logged-in TradingView Desktop
window with a `/chart` page target; indicators must be **on-chart and visible** for value tools to
see them; timing is governed by fixed sleeps and a best-effort `waitForChartReady` that returns
`false` (rather than failing) on timeout, so reads can race a still-loading chart
(`src/wait.js:63-71`). Screenshots are written into the install directory, not a configurable output
path.

✅ Section 6 complete.

---

## 7. HOW TO RUN IT

### Prerequisites
- **TradingView Desktop app**, paid subscription, launched with `--remote-debugging-port=9222` (the
  debug port is off by default) (`README.md:9,:21,:50-51`, `SETUP_GUIDE.md:34-57`). The tool does
  **not** bypass the paywall or log you in — you must sign in once in TradingView Desktop itself.
- **Node.js 18+** (`README.md:51`).
- CDP endpoint `127.0.0.1:9222` by default, overridable via `TV_CDP_HOST`/`TV_CDP_PORT`
  (`src/connection.js:5-9`) `[2026-09-18]`.
- **Windows: the supported install is the Microsoft Store / MSIX package** — there is **no
  standalone Windows build** (the `https://www.tradingview.com/desktop/` download installs the Store
  package into `WindowsApps`). `[2026-09-18, upstream main]` Both launchers now handle it directly:
  `tv_launch` finds it via `Get-AppxPackage` and spawns it with `--remote-debugging-port`, falling
  back to a local copy of the package if that fails; `scripts\launch_tv_debug.bat` finds it the same
  way and starts it directly. `scripts/launch_msix_debug.ps1` (COM activation) is kept as a
  **standalone manual fallback** — see "Windows: launching the MSIX/Store build" below.
- **Do not launch TradingView from a process that has `ELECTRON_RUN_AS_NODE=1` in its
  environment** (VS Code-family extension hosts set it; see §8 item 5) — the Electron app then runs
  as plain Node and exits with `bad option: --remote-debugging-port`.

### Install + wire up
```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git ~/tradingview-mcp
cd ~/tradingview-mcp && npm install                 # SETUP_GUIDE.md:5-11
```
MCP config in `~/.claude/.mcp.json` (or project `.mcp.json`) (`SETUP_GUIDE.md:16-32`):
```json
{ "mcpServers": { "tradingview": { "command": "node", "args": ["<INSTALL_PATH>/src/server.js"] } } }
```
Restart Claude Code, then verify with the `tv_health_check` tool (expects
`{success, cdp_connected:true, chart_symbol, api_available}`) (`SETUP_GUIDE.md:59-80`). Optional
CLI: `npm link` to expose `tv` globally (`SETUP_GUIDE.md:82-91`, `package.json:7-9`).

### Launch TradingView with CDP (from the repo's own scripts)
- **Windows:** `scripts\launch_tv_debug.bat [port]` `[2026-09-18: upstream main's version]` —
  default 9222; `taskkill /F /IM TradingView.exe`; checks the classic install paths, then the
  **MSIX/Store** install via `Get-AppxPackage` (`scripts/launch_tv_debug.bat:21-28`), then
  `WindowsApps` / `where`; starts the exe directly with `--remote-debugging-port=<port>` (`:47`);
  polls `127.0.0.1:<port>/json/version` up to 30 times and, on failure, points to `tv_launch`'s
  local-copy fallback (`:59-64`). It does **not** call `launch_msix_debug.ps1`. The `.bat` path was
  not live-tested on 2026-09-18 (only `tv_launch` was). The orphan `scripts/launch_tv_debug.vbs`
  (process-scope `ELECTRON_EXTRA_LAUNCH_ARGS` + AUMID activation) does **not** work and is unused.
- **Windows manual fallback:** `powershell -NoProfile -File scripts\launch_msix_debug.ps1 [-Port 9222]`
  — COM activation; use it if the direct and local-copy paths ever stop working (see below).
- **macOS:** `./scripts/launch_tv_debug_mac.sh [port]` — detects
  `/Applications/TradingView.app/Contents/MacOS/TradingView`, `pkill -f TradingView`, launches with
  `--remote-debugging-port=$PORT &`, polls 15×1 s (`scripts/launch_tv_debug_mac.sh:3-65`).
- **Linux:** `./scripts/launch_tv_debug_linux.sh [port]` — checks `/opt`, `~/.local/share`,
  `/usr/bin`, snap, flatpak paths, `pkill`, launch, poll 15×1 s (`scripts/launch_tv_debug_linux.sh:3-65`).
- **Any platform manual:** `/path/to/TradingView --remote-debugging-port=9222`
  (`SETUP_GUIDE.md:41-57`).
- **Via MCP tool / CLI:** `tv_launch` (`tv launch`) reimplements detection in Node and `spawn`s with
  `--remote-debugging-port` (`src/core/health.js:286-401`) `[2026-09-18, upstream main]`. On Windows
  it resolves the Store install via `Get-AppxPackage` (`:317-328`); for a `WindowsApps` path it
  waits 1.5 s for an early exit and up to 15 s for CDP, and if either fails copies the package to
  `%LOCALAPPDATA%\tradingview-mcp\<package>` and relaunches from the copy (`:267-284`, `:367-381`).

### Windows: launching the MSIX/Store build (empirical, verified 2026-07-08; re-tested 2026-09-18)
Upstream ships **MSIX / Microsoft Store only** — there is **no standalone Windows build**. The
`https://www.tradingview.com/desktop/` download installs the **Store MSIX package** (confirmed
empirically: `TradingView.Desktop` v3.3.0.7992 landed in `WindowsApps`).

**`[2026-09-18]` Primary path: upstream `tv_launch`, direct spawn from `WindowsApps`.** Live test on
`TradingView.Desktop_3.4.1.8194_x64__n534cwy3pjxzj` (TradingView 3.4.1, Electron 41.7.1, Chrome
146), `tv launch` via the CLI on port 9223 (`TV_CDP_PORT=9223`): the direct spawn opened CDP in
**2.9 s**, `tv status` reported `cdp_connected: true` at **3.9 s**, and the saved layout loaded
signed in. The local-copy fallback was not needed. The first attempt the same day failed on both
paths with `bad option: --remote-debugging-port` because the launching shell had
`ELECTRON_RUN_AS_NODE=1` (§8 item 5); with that variable removed it worked.

**Local-copy fallback caveat (inferred, not live-verified here):** the Store build keeps its
signed-in profile in the package-virtualized folder
`%LOCALAPPDATA%\Packages\TradingView.Desktop_n534cwy3pjxzj\LocalCache\Roaming\TradingView`. A copy
run from `%LOCALAPPDATA%\tradingview-mcp\` has no package identity, so it would use the real
`%APPDATA%\TradingView` (absent on this machine) and most likely start **signed out** — contrary to
upstream's note that the copy keeps the session.

**If the direct and local-copy paths ever break, use `scripts/launch_msix_debug.ps1`** (COM
activation, below). It launches through the shell activation broker, so it is also unaffected by
`ELECTRON_RUN_AS_NODE` in the caller's environment, and it runs the real packaged app with its
normal signed-in profile.

History — what was observed **not** working on 2026-07-08 (v3.3.0.7992):
- `Start-Process` of the raw `WindowsApps\...\TradingView.exe` with `--remote-debugging-port` — port
  9222 never opened. `[2026-09-18: a direct spawn worked on v3.4.1.8194 when ELECTRON_RUN_AS_NODE
  was unset; the July failure may have had the same cause, but that was not re-tested on 3.3.0.]`
- The `.vbs` pattern / a `ELECTRON_EXTRA_LAUNCH_ARGS` env var set at runtime — the shell activation
  broker inherits the environment it had at login and does not see a later-set var. A **User-scope**
  var applies only after a logout/login and is global to every Electron app, so it is not viable; the
  User-scope `ELECTRON_EXTRA_LAUNCH_ARGS` that had been set for this was **removed on 2026-07-08**.

What **worked** on 2026-07-08, and is now the **standalone manual fallback** — `scripts/launch_msix_debug.ps1` (adapted from
`github.com/emremigh/tradingview-mcp-windows-msix-fix`): it calls the Windows shell
`IApplicationActivationManager::ActivateApplication(aumid, "--remote-debugging-port=9222", ...)`,
which **does** forward the argument to the packaged Electron process. Verified: the activated
`TradingView.exe` shows `--remote-debugging-port=9222` on its command line, `127.0.0.1:9222` listens,
and `http://localhost:9222/json/version` returns a valid CDP payload (Chrome/140, Electron/38.2.2).
**Timing caveat:** the debug port opens ~45–90 s after activation (MSIX cold start; observed up to
~95 s once), so the launcher polls up to 120 s (`-WaitSeconds`). `[2026-09-18]` Nothing invokes this
script automatically any more — upstream's `scripts/launch_tv_debug.bat` launches the Store exe
directly — so run it by hand. It was not re-tested on v3.4.1. Requires an execution policy that permits local scripts (this
machine: `RemoteSigned`); no `-ExecutionPolicy Bypass` is used. The script's default `-Aumid` is
`TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop`; pass `-Aumid` to override for a different
package hash.

### Usage after launch
CLI examples: `tv status`, `tv quote ES1!`, `tv symbol AAPL`, `tv ohlcv -n 20 --summary`,
`tv screenshot -r chart`, `tv values`, `tv data lines -f Profiler`, `tv pine compile`,
`tv pane layout 2x2`, `tv stream quote | jq '.close'` (`README.md:151-199`).

✅ Section 7 complete.

---

## 8. ISSUES & OPPORTUNITIES

### Confirmed bugs
1. **Three `chart.js` functions throw `ReferenceError` at runtime (BROKEN).** `src/core/chart.js:4`
   imports `evaluate` only as `_evaluate`, but `getVisibleRange` (`:119`), `scrollToDate`
   (`:166,:178`), and `symbolInfo` (`:200`) call a **bare `evaluate(...)`** that is not in scope
   (and, unlike sibling functions, don't resolve it via `_resolve(_deps)`). Under ESM strict mode
   these throw `evaluate is not defined`. **Net effect: `chart_get_visible_range`,
   `chart_scroll_to_date`, and `symbol_info` are non-functional.** *(Independently confirmed against
   a direct read of `src/core/chart.js`.)*
2. **[RESOLVED, live-checked 2026-09-22] `alert_create` silently ignores its `condition` param** —
   this claimed DOM-dialog behavior at `alerts.js:72` does not exist in the current source: `create()`
   (`src/core/alerts.js:18`) sends `condition` through `CONDITION_TYPE_MAP` into the REST
   `/create_alert` payload's `conditions[0].type`, and it is honored. Unknown when this was fixed
   relative to the `dc7f294` audit this document was originally written against — flagging as a
   documentation error rather than claiming credit for a fix made in this session. **Separately, the
   real limitation this item's W1 backlog task existed to close — `alert_create` only builds *price*
   alerts, with no way to alert on an indicator/Pine-study plot — is now closed**: `alert_create_study`
   and `alert_update` (`src/core/alerts.js`, `src/tools/alerts.js`) add indicator-condition alert
   create/update, reverse-engineered from `alert_list`'s payload shape and a live study's
   `stateForAlertAsync()`. Live-verified end-to-end (create → list-verify → update → list-verify →
   delete → confirm gone) on a throwaway alert against COINBASE:BTCUSD study `JJayFq`; see the new
   capabilities-table rows above.
3. **[RESOLVED, live-checked 2026-09-22] Alert deletion is effectively stubbed** — this claimed
   context-menu/"not yet supported" behavior at `alerts.js:106-122` does not exist in the current
   source: `deleteAlerts()` sends `alert_ids` to REST `/delete_alerts` and works for both a single id
   and `delete_all`; live-verified in this session (§ above). Same caveat as item 2: flagging a stale
   claim, not claiming a fix.
4. **`stream` / `pane` / `tab` are missing from the public core export** (`src/core/index.js:5-16`),
   so `tradingview-mcp/core` consumers cannot reach panes, tabs, or streaming.
5. **`[2026-09-18]` `tv_launch` breaks when `ELECTRON_RUN_AS_NODE` is inherited.** (The earlier item
   — "`tv_launch` has no MSIX/Store detection" — is **resolved on upstream `main`**:
   `src/core/health.js:317-328`, with a local-copy fallback at `:367-381`.) `launch()` spawns
   TradingView with the caller's full environment (`_spawnDetached`, `src/core/health.js:230-234`).
   If that environment has `ELECTRON_RUN_AS_NODE=1` — VS Code-family extension hosts set it, and
   MCP servers or shells started from them inherit it — the Electron binary runs as plain Node and
   exits at once with `bad option: --remote-debugging-port=<port>`. **Both** the direct `WindowsApps`
   spawn and the local-copy relaunch fail this way: observed live 2026-09-18, where `launch()` returned
   `cdp_ready: false` after 22 s and the port never opened within 120 s. The same test with the
   variable removed passed in 3.9 s. Fix (not applied here, since `src/` is upstream's): strip
   `ELECTRON_RUN_AS_NODE` from the spawn `env`. `scripts/launch_msix_debug.ps1` is unaffected (COM
   activation takes its environment from the activation broker). Not yet checked: whether the MCP
   servers spawned by Claude Desktop inherit the variable.
6. **Wrong macOS bundle id** in the Spotlight fallback:
   `kMDItemCFBundleIdentifier == 'com.niceincontact.TradingView'`
   (`scripts/launch_tv_debug_mac.sh:23`) — `com.niceincontact` is a different vendor, so that
   `mdfind` fallback essentially never matches.

### Correctness / consistency risks
- **Two different graphics/value read conventions** (`src/core/data.js` `y1/y2/t/tid` vs
  `src/core/stream.js` `points[].price`/`.text`). **CONFIRMED (live 2026-07-08, build 3.3.0.7992):**
  the `stream.js` convention is **stale/broken** — `tv stream values` returns garbage `_start/_end`
  keys, `tv stream lines`/`tables` return empty — while the `data.js` convention (MCP `data_get_*`)
  is **authoritative** (real values, labels, tables). Fix `stream.js` to the `data.js` field
  convention before any daily job relies on `tv stream *` (§4).
- **Port/host configuration** `[2026-09-18, upstream main]` — the connection layer now reads
  `TV_CDP_HOST`/`TV_CDP_PORT` (`src/connection.js:5-9`). Still hardcoded to `localhost:9222`:
  `scripts/pine_pull.js:6,9` and `scripts/pine_push.js:9,12`. `tv_launch --port` still does not move
  the connection layer by itself; set `TV_CDP_PORT` to the same value.
- **Doc/count contradictions:** tool count 70 (`src/cli/index.js:8`) vs 84 (`CLAUDE.md`,
  `src/server.js:25`, README — corrected 2026-09-22; this doc previously and wrongly claimed 68/78
  here) vs **86 actual** as of the W1 alert tools (2026-09-22, not yet reflected in any of those three
  docstrings — see the tool-table total-count note above); advertised pane layouts (6) understate
  implemented (18).
- **`alert_update` requires the alert's study to be on the current chart** (`src/core/alerts.js`,
  `updateAlert`) — added 2026-09-22 as a blanket safety check alongside `alert_create_study`, but it's
  unnecessarily strict for patches that don't touch the condition (e.g. `message`-only or
  `active`-only updates need no chart-side study lookup at all). Backlog: relax to only require the
  study lookup when `condition`, `value`, `frequency`, or `resolution` is being patched.
- **"Local only / no TradingView servers" claims are not strictly true** — `alerts.list` calls
  `pricealerts.tradingview.com` with `credentials:'include'` (`src/core/alerts.js:66`),
  `symbol_search` calls `symbol-search.tradingview.com` (`src/core/chart.js:225`), and `pine_check`
  uses `pine-facade.tradingview.com` (`src/connection.js:26`), contradicting `README.md:19,:187` and
  `CONTRIBUTING.md:23`.

### Fragility / races (acknowledged in `README.md:14-15`, `RESEARCH.md:69-73`)
- Deep private paths hardcoded in `src/connection.js:11-27` (`_activeChartWidgetWV`,
  `_chartWidgetCollection`, `_replayApi`, `_alertService`, `window.ChartApiInstance`,
  `bottomWidgetBar`) — any rename breaks everything.
- React-fiber walk to the Monaco editor (`scripts/pine_pull.js:13`, `scripts/pine_push.js:18`) and
  compile-button-by-visible-text matching (`scripts/pine_push.js:27`) — break on refactor/locale.
- Class-substring/`data-name` DOM selectors throughout `capture`, `health.uiState`, `wait.js`,
  `alerts`, `watchlist`, `ui`; `layout_switch` dialog dismissal by button-text regex
  (`src/core/ui.js:150`).
- Timing: `waitForChartReady` returns `false` (not error) on timeout so reads race a loading chart
  (`src/wait.js:63-71`); the "bar count" readiness check matches any `[class*="bar"]` (toolbars too)
  (`src/wait.js:23-24`); fixed sleeps — `manageIndicator` 1500 ms (`chart.js:100`), `layout_switch`
  500/1000 ms (`ui.js:144,:159`), `pine_push` 3000 ms (`scripts/pine_push.js:38`), batch 2000 ms
  (`batch.js:35`).

### Top 5 improvements for automated daily extraction of the 8 IA indicator values
Ranked by impact on the goal (§4):

1. **Add a one-call "read named indicators" extractor.** A `data_get_indicator_outputs({names[]})`
   that, per name, unions `data_get_study_values` + the four `data_get_pine_*` results filtered by
   that name, and returns a flat `{indicator: {metric: value}}` map. Removes 5 tool calls ×
   name-matching per indicator and gives the portfolio app a stable contract independent of whether
   each value is a plot vs a drawing. Foundation: `src/core/data.js:324-454`.
2. **Guarantee the indicators are on-chart before reading.** Add an idempotent "ensure applied +
   visible" step — either resolve/attach each IA script (`chart.manageIndicator add`,
   `src/core/chart.js:87`) or `layout_switch` to a saved layout that already contains them
   (`src/core/ui.js:120`) — then force `toggleVisibility(true)` (`src/core/indicators.js:40`). The
   #1 silent failure for daily extraction is an indicator simply not being present/visible, since
   absent studies never appear in `dataSources()`.
3. **Reconcile the `data.js` vs `stream.js` field conventions and pin them to the shipping build**
   (§4 divergence). Pick one primitive-key convention, add a self-test that reads a known indicator
   and asserts non-empty, and fail loudly (rather than `try/catch`→empty) when the object shape
   changes — otherwise a TradingView update yields silently empty daily pulls.
4. **Fix the port hardcoding and the three broken `chart.js` reads.** Thread `CDP_PORT` from an env
   var / arg through `src/connection.js` so extraction can run against a non-default port, and fix
   the bare-`evaluate` bug so `symbol_info`/range/scroll work (needed for reliable
   symbol/timeframe context around each extraction).
5. **Add a screenshot+region fallback for fill/bgcolor-only outputs.** For IA values with no
   numeric path (e.g. cloud/zone rendered via `fill()`/`bgcolor()`, DCAS/Arb Cloud per §4), wire
   `capture_screenshot` of the indicator pane into the daily job so a human/OCR step can recover
   what the value tools structurally cannot (`src/core/capture.js:12`).

✅ Section 8 complete.

---

*End of audit. Scope was read-only discovery. Nothing was modified besides creating this file;
TradingView was not launched and port 9222 was not contacted.*

*[2026-09-18] Updated when carried onto upstream `main` `c05b8f5`: the launch material and the CDP
host/port statements were revised, based on a live `tv launch` test on port 9223. See
`RECONCILE-2026-09-18.md`.*
