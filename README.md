# omp-live-stats

Oh My Pi extension for measured output throughput and estimated prefill speed.

## Status and report

The status line shows the last completed assistant response:

```
Last TPS 60.0 tok/s · Prefill ~2400.0 tok/s
```

Run `/live-stats` for the current branch's session statistics. The report is a
ten-line widget below the editor; it is not injected into model context.
`/live-stats off` closes only the widget and leaves the compact status.

Metrics are unavailable (`—`) when the host did not persist timing fields, the
request was too short for a meaningful whole-request rate, the response errored,
or the prompt had no uncached tokens. Errors and aborts are still counted.

## Measurement rules

- **TPS** is output tokens over the provider-reported whole-request duration,
  using omp's `calculateTokensPerSecond` helper. It includes reasoning, text, and
  tool-argument output and never adds reasoning tokens on top. Session TPS is
  `sum(output) / sum(duration)` over valid samples, not a mean of per-response
  rates.
- **Prefill** is an estimate: `(usage.input + usage.cacheWrite) * 1000 / ttft`.
  Cache reads are excluded because those tokens were not newly prefetched. TTFT
  includes queueing, network, and provider output-event latency, so the value is
  not server compute speed.
- **TTFT** is the provider-reported time to the first output event. It must be
  positive and no longer than a reported positive request duration.
- **Scope** is the assistant messages of the active main-agent branch, including
  entries before `/clear` boundaries and compactions. Subagent usage and other
  branches are not folded in. `/clear` keeps the statistics; a new session starts
  empty.
- Statistics are reconstructed from native session messages. Nothing extra is
  written, and a resumed session restores the same metrics when its messages
  retain timing fields.

## Install

Link the working copy:

```sh
omp plugin link .
```

Or load it for a single run:

```sh
omp --no-extensions -e ./src/index.ts
```

## Powerline status line

The compact status is emitted through `ctx.ui.setStatus`, which omp renders via
its `status` segment. Add that segment to a custom preset to place the readout
inside the powerline bar instead of on the hook-status row below the editor.

This example preserves the built-in `default` preset's segments and options and
inserts `status` after `mode`:

```yaml
statusLine:
  preset: custom
  leftSegments: ["pi", "vim", "model", "mode", "status", "collab", "stream", "path", "git", "pr", "context_pct", "cost"]
  rightSegments: ["session_name"]
  separator: powerline-thin
  segmentOptions:
    model:
      showThinkingLevel: true
    path:
      abbreviate: true
      maxLength: 40
      stripWorkPrefix: true
    git:
      showBranch: true
      showStaged: true
      showUnstaged: true
      showUntracked: true
  showHookStatus: false
```

Add the block to `~/.omp/agent/config.yml`. `preset: custom` is required because
the other presets ignore `leftSegments`/`rightSegments` and none includes
`status`; a custom preset starts with empty `segmentOptions`, so copy the
options above to keep the default path and git rendering. Set
`showHookStatus: false` to avoid the same text also appearing as a row below the
editor. The equivalent settings can be written with `omp config set` using JSON
for the array and record values.

## Development

Requires Bun >= 1.3.14 for the tests and development dependencies:

```sh
bun install
bun test
```

`@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-ai` are pinned to `18.12.6` for
types and the TPS helper; omp provides the runtime host. No build step is
needed because `omp.extensions` points at the TypeScript entry.
