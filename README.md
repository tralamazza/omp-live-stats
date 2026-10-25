# omp-live-stats

Oh My Pi extension for measured output throughput and estimated prefill speed.

## Status and report

The footer shows the last completed assistant response:

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
omp plugin link /home/tralamazza/github/tralamazza/omp-live-stats
```

Or load it for a single run:

```sh
omp --no-extensions -e /home/tralamazza/github/tralamazza/omp-live-stats/src/index.ts
```

The footer status relies on omp's hook-status rendering. With `showHookStatus`
enabled (the default) it trails the configured status segments; a custom preset
must include the `status` segment instead.

## Development

Requires Bun >= 1.3.14 for the tests and development dependencies:

```sh
bun install
bun test
```

`@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-ai` are pinned to `18.12.6` for
types and the TPS helper; omp provides the runtime host. No build step is
needed because `omp.extensions` points at the TypeScript entry.
