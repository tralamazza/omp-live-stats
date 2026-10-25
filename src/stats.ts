import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";

/** Stop reason as recorded on an assistant message. */
export type AssistantStopReason = AssistantMessage["stopReason"];

/** Per-response speed sample derived from one finalized assistant message. */
export interface ResponseMeasurement {
	provider: string;
	model: string;
	stopReason: AssistantStopReason;
	/** Whole-request output throughput; null when the host reported no usable timing. */
	tps: number | null;
	/** Estimated uncached-prompt throughput over TTFT; null when it cannot be measured. */
	prefillTps: number | null;
	/** Provider-reported time to first output event; null when unavailable or invalid. */
	ttftMs: number | null;
}

/** Reported token buckets summed over the current branch. */
export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Aggregates for the current main-agent branch. Rates are weighted, never averaged. */
export interface SessionStatistics {
	responses: number;
	errors: number;
	aborts: number;
	tokens: TokenTotals;
	/** Summed output / summed duration over TPS-valid responses. */
	tps: number | null;
	tpsSamples: number;
	/** Summed uncached prompt / summed TTFT over prefill-valid responses. */
	prefillTps: number | null;
	prefillSamples: number;
	/** Summed validated TTFT / sample count. */
	meanTtftMs: number | null;
	ttftSamples: number;
}

interface Timings {
	tps: number | null;
	prefillTps: number | null;
	ttftMs: number | null;
	/** Accumulators are zero unless the corresponding sample is valid. */
	tpsTokens: number;
	tpsDurationMs: number;
	prefillTokens: number;
	prefillTtftMs: number;
}

const NO_TIMINGS: Timings = {
	tps: null,
	prefillTps: null,
	ttftMs: null,
	tpsTokens: 0,
	tpsDurationMs: 0,
	prefillTokens: 0,
	prefillTtftMs: 0,
};

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A reported bucket; malformed or negative values contribute nothing. */
function tokenBucket(value: unknown): number {
	const bucket = finiteNumber(value);
	return bucket !== null && bucket >= 0 ? bucket : 0;
}

function weightedRate(numerator: number, denominator: number): number | null {
	if (!Number.isFinite(numerator) || numerator <= 0) return null;
	if (!Number.isFinite(denominator) || denominator <= 0) return null;
	const rate = (numerator * 1000) / denominator;
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Validate the timing fields of a successful (or aborted) response.
 *
 * TPS delegates its duration and output validation to the host helper, which
 * deliberately uses the whole request duration and rejects spans under 100 ms.
 * Prefill is estimated: uncached prompt tokens (input + cache write, never
 * cache reads) over TTFT. TTFT is only trusted when it is positive and does
 * not exceed a reported positive request duration.
 */
function measureTimings(message: AssistantMessage): Timings {
	const usage = message.usage ?? {};
	const duration = finiteNumber(message.duration);
	const durationCap = duration !== null && duration > 0 ? duration : null;
	const reportedTtft = finiteNumber(message.ttft);
	const ttftMs =
		reportedTtft !== null && reportedTtft > 0 && (durationCap === null || reportedTtft <= durationCap)
			? reportedTtft
			: null;

	const output = finiteNumber(usage.output);
	const tps = calculateTokensPerSecond([message], false);
	const tpsValid = tps !== null && output !== null && output > 0 && duration !== null && duration > 0;

	const input = finiteNumber(usage.input);
	const cacheWrite = finiteNumber(usage.cacheWrite);
	let prefillTps: number | null = null;
	let prefillTokens = 0;
	let prefillTtftMs = 0;
	if (ttftMs !== null && input !== null && input >= 0 && cacheWrite !== null && cacheWrite >= 0) {
		const uncachedPrompt = input + cacheWrite;
		const rate = uncachedPrompt > 0 ? (uncachedPrompt * 1000) / ttftMs : null;
		if (rate !== null && Number.isFinite(rate) && rate > 0) {
			prefillTps = rate;
			prefillTokens = uncachedPrompt;
			prefillTtftMs = ttftMs;
		}
	}

	return {
		tps: tpsValid ? tps : null,
		prefillTps,
		ttftMs,
		tpsTokens: tpsValid ? (output as number) : 0,
		tpsDurationMs: tpsValid ? (duration as number) : 0,
		prefillTokens,
		prefillTtftMs,
	};
}

/** Measure the finalized response that should drive the compact status line. */
export function measureResponse(message: AssistantMessage): ResponseMeasurement {
	const timings = message.stopReason === "error" ? NO_TIMINGS : measureTimings(message);
	return {
		provider: String(message.provider ?? ""),
		model: String(message.model ?? ""),
		stopReason: message.stopReason,
		tps: timings.tps,
		prefillTps: timings.prefillTps,
		ttftMs: timings.ttftMs,
	};
}

/**
 * Aggregate every assistant response in the supplied branch, including entries
 * before reset boundaries and compactions. Rates are weighted by their own
 * denominators, and each rate exposes the sample count behind it.
 */
export function summarizeSession(messages: readonly AssistantMessage[]): SessionStatistics {
	let responses = 0;
	let errors = 0;
	let aborts = 0;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let tpsTokens = 0;
	let tpsDurationMs = 0;
	let tpsSamples = 0;
	let prefillTokens = 0;
	let prefillTtftMs = 0;
	let prefillSamples = 0;
	let ttftTotalMs = 0;
	let ttftSamples = 0;

	for (const message of messages) {
		responses++;
		if (message.stopReason === "error") errors++;
		else if (message.stopReason === "aborted") aborts++;

		const usage = message.usage ?? {};
		input += tokenBucket(usage.input);
		output += tokenBucket(usage.output);
		cacheRead += tokenBucket(usage.cacheRead);
		cacheWrite += tokenBucket(usage.cacheWrite);

		if (message.stopReason === "error") continue;

		const timings = measureTimings(message);
		if (timings.tps !== null) {
			tpsTokens += timings.tpsTokens;
			tpsDurationMs += timings.tpsDurationMs;
			tpsSamples++;
		}
		if (timings.prefillTps !== null) {
			prefillTokens += timings.prefillTokens;
			prefillTtftMs += timings.prefillTtftMs;
			prefillSamples++;
		}
		if (timings.ttftMs !== null) {
			ttftTotalMs += timings.ttftMs;
			ttftSamples++;
		}
	}

	return {
		responses,
		errors,
		aborts,
		tokens: { input, output, cacheRead, cacheWrite },
		tps: tpsSamples > 0 ? weightedRate(tpsTokens, tpsDurationMs) : null,
		tpsSamples,
		prefillTps: prefillSamples > 0 ? weightedRate(prefillTokens, prefillTtftMs) : null,
		prefillSamples,
		meanTtftMs: ttftSamples > 0 ? ttftTotalMs / ttftSamples : null,
		ttftSamples,
	};
}

/**
 * Keep message entries whose role is assistant. Other entry types (reset
 * boundaries, compactions, labels, custom records) and non-assistant messages
 * are skipped without truncating the walk, so pre-reset history stays included.
 */
export function collectAssistantMessages(entries: readonly SessionEntry[]): AssistantMessage[] {
	const messages: AssistantMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		messages.push(entry.message);
	}
	return messages;
}
