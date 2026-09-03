# dsh-session-health

[中文](README.md)

DSH session health check plugin — performs frame-level scan diagnostics on **multi-frame zstd session files** under `$DSH_HOME/sessions` (torn / corrupted / empty sessions / stray files), and outputs a health report with cleanup suggestions. **Read-only**: never modifies or deletes any file.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Repository: [https://github.com/omdsh-dev/dsh-session-health](https://github.com/omdsh-dev/dsh-session-health) (public)

## Motivation

While investigating issue #376 on 8/7, we ran a full decode analysis over 39 session files and discovered a key fact in the process: **DSH session files are a concatenation of multiple zstd frames** (a 19MB session = 119,952 frames). Reading a multi-frame file with a single-frame decode API only reveals the header — which once caused a false "all sessions empty" judgment. This diagnostic logic deserves to be productized as a tool: the model can directly ask "is my session file healthy" instead of relying on hand-written scripts.

Complementary to `dsh-session-repair-skill` (which repairs corrupted sessions): this tool **discovers via read-only diagnostics** → the repair skill **repairs**.

## Security Model

- **Read-only guarantee**: never modifies/deletes any file (covered by the "file byte counts unchanged after scanning" test, see the files.spec SH-06 case)
- **Path fencing**: session ids go through a strict directory-name whitelist (prevents `../` traversal); both the absolute path and the final file pass `fs.realpath` real-path containment checks (prevents symlink/junction escape); enumeration uses lstat to reject symlinks
- **Zero business dependencies**: the zstd frame scanner is an independent implementation (reads bytes with DataView, RFC 8878 structure, differential-consistent with the official `scanZstdFrames`)
- **Deep analysis optional**: with `deep: true` the official decoder is dynamically imported; on parse failure it explicitly degrades to `deep: "unavailable"`, never silently
- Fixed input scope (sessions directory), no network, no execution surface

## Tool Declaration

Registers the `session_health` tool (`@deepseek-ai/dsh-session-health`, row id `tool-session-health`), uniformly outputting JSON text.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `scan` / `file` / `stats` |
| `path` | string | | Absolute file path (must be within the sessions root) or session id (required for file/stats) |
| `deep` | boolean | | Deep analysis (decoded event statistics), default false |
| `detail` | boolean | | List abnormal files (scan defaults to true); false returns only the summary |

## Detection Items

| Category | Determination |
|---|---|
| `missing` | Session id resolves to no file |
| `empty` | 0-byte file |
| `not-zstd` | First 4 bytes are not `28 b5 2f fd` (plaintext .jsonl or corrupted) |
| `torn` | EOF interrupts a frame tail (interrupted write) |
| `reserved-header` / `reserved-block` | Invalid reserved bits in the frame header/block header (structural corruption) |
| `bad-header` | deep mode: the first frame is not a session header |
| `empty-session` | Only 1 frame (header) and not updated for over 1 minute |
| `oversized-single-frame` | Single frame > 1MB (normal multi-frame writes do not do this) |
| `interrupted` | deep mode: has turn/start but no turn/end (process killed/crashed) |
| `stray-file` | `*.tmp` / leftover files with non-standard names |

The report contains: `root / scanned / errors / suspicious / totals(bytes·frame count·event-batch estimate) / detail / deep / suggestions` (suggestions give cleanup/repair advice per the issue template, not executed automatically).

## Examples

```
session_health { action: "scan" }
  → {"root":"C:\\Users\\admin\\.dsh\\sessions","scanned":39,"errors":{...},"suspicious":{...},"suggestions":[...]}

session_health { action: "file", path: "session-abc123", deep: true }
  → 单文件报告（含事件分布与中断检测）
```

## DSH 0.1.2-rc.1 Compatibility (verified)

This plugin has been migrated to the DSH 0.1.2-rc.1 harness, and full end-to-end verification was completed in an isolated consumer of `local harness 0.1.2-rc.1`:

- **Types/runtime**: `@deepseek-ai/cordis@^4.0.1` + `@deepseek-ai/dsh-tools@>=0.0.1-rc.1 <0.2.0` + `@deepseek-ai/dsh-invariants@>=0.0.1-rc.1 <0.2.0` (peer); no longer depends on unscoped `cordis`
- **Standalone build**: `npm install` (devDependencies self-contain typescript/vitest/@types/node) → `npm run typecheck` → `npm test` → `npm run build` → `npm pack`
- **Consumption verification**: tarball loaded into an rc.8 consumer → the plugin's row appears in `dsh --profile compat --dump-config` → real tool registration and execution passed
- **Startup method**: `npx -p @deepseek-ai/dsh@next dsh web` (lib production mode; do not `install -g` globally)

> Known limitation: under DSH 0.1.2-rc.1, the `@deepseek-ai/dsh-session-persistence-jsonl` tarball that deep mode depends on still does not include src/, and its root entry still does not export the zstd API; deep degrades to `decoder-unavailable`; frame-level scanning is unaffected (reported to dsh-external/issues — that organization is org infrastructure and remains in place).


## Installation

Under DSH 0.1.2-rc.1, plugins are installed via `dsh plugin --profile <profile> add <source>`; source is a GitHub repository or an npm pack tarball.

### Install from GitHub (Recommended)

```sh
# 交互式（web）profile
dsh plugin --profile web add github:omdsh-dev/dsh-session-health
# 一次性任务（headless）profile —— dsh run 默认使用 headless
dsh plugin --profile headless add github:omdsh-dev/dsh-session-health
```

### Install from npm pack tarball

The `npm pack` artifact can be installed directly as source:

```sh
dsh plugin --profile web add dsh-session-health-*.tgz
```

The bundled `dsh.bundle.patch` automatically adds the plugin to the profile's layer stack after installation (row id: `tool-session-health`). The plugin's missing peer dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`) are provided by the profile's healed `profiles/node_modules` fallback installation.

> ⚠️ web and headless are **different profiles**: installing into web does not automatically cover headless; `dsh run` uses the headless profile by default. Use forward slashes for Windows paths (`C:/...`).

### Verifying the Installation

```sh
dsh --profile web --dump-config | grep tool-session-health
```

### Runtime Verification

```sh
dsh run "使用 session_health 工具扫描会话目录健康状态"
```

### Legacy Scenario: monorepo / Local-Path Installation

The monorepo approach is now a legacy scenario (local junction/symlink, manually editing the profile layer, legacy snapshots without GitHub/tarball source support):

```sh
dsh plugin --profile web add "C:/path/to/dsh-session-health"
```
## Testing

```bash
node <monorepo>/node_modules/vitest/vitest.mjs run tests
```

- `zstd-scan.spec.ts`: boundaries of frames generated by the official compressor / multi-frame / not-zstd / truncated / reserved bits + **real-session differentials** (large/medium/small files frame-by-frame identical to the official `scanZstdFrames`; reads local sessions read-only, not committed to the repo)
- `files.spec.ts`: two-level directory enumeration, stray/jsonl identification, path fencing (traversal/symlink/out-of-bounds rejection), session id resolution, read-only guarantee
- `report.spec.ts`: error/suspicious count bucketing, suggestions templates, empty results, deep degradation annotation
- `register.spec.ts`: registration contract (AUDIT-CROSS-02 style)

## Known Limitations

- `deep` depends on dynamically importing the official decoder: at runtime in a profile, if the package cannot be resolved, it explicitly degrades to frame-level scanning (the report is annotated with `deep: "unavailable"`)
- Event-batch estimate = frame count - 1 (each batch has at least 1 frame; **not an exact event count**, the report notes it is an estimate)

## License

MIT
