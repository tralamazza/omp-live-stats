import type { ResponseMeasurement, SessionStatistics } from "./stats";

const UNAVAILABLE = "—";
const MAX_LABEL_LENGTH = 72;

function formatRate(value: number | null, estimated = false): string {
	if (value === null || !Number.isFinite(value) || value <= 0) return UNAVAILABLE;
	return `${estimated ? "~" : ""}${value.toFixed(1)} tok/s`;
}

function formatMilliseconds(value: number | null): string {
	if (value === null || !Number.isFinite(value) || value < 0) return UNAVAILABLE;
	return `${value.toFixed(1)} ms`;
}

function formatSamples(count: number): string {
	return `${count} ${count === 1 ? "sample" : "samples"}`;
}

/** One line, no control characters, and a bounded width for the report. */
function formatLabel(value: string): string {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length === 0) return "unknown";
	return cleaned.length <= MAX_LABEL_LENGTH ? cleaned : `${cleaned.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

/** Compact footer status for the last completed response. */
export function formatStatus(last: ResponseMeasurement | null): string {
	const parts = [`Last TPS ${formatRate(last?.tps ?? null)}`, `Prefill ${formatRate(last?.prefillTps ?? null, true)}`];
	if (last?.stopReason === "error") parts.push("error");
	else if (last?.stopReason === "aborted") parts.push("aborted");
	return parts.join(" · ");
}

/**
 * On-demand report: exactly ten content lines, ordered from session scope to
 * per-response detail. Prefill is always marked as an estimate.
 */
export function formatReport(stats: SessionStatistics, last: ResponseMeasurement | null): string[] {
	const lastLine = last
		? `Last: ${formatLabel(`${last.provider}/${last.model}`)} · ${formatLabel(last.stopReason)}`
		: "Last: No completed responses";
	return [
		"Session statistics (current branch)",
		`Responses: ${stats.responses} · Errors: ${stats.errors} · Aborts: ${stats.aborts}`,
		lastLine,
		`Last TPS: ${formatRate(last?.tps ?? null)} · Prefill ${formatRate(last?.prefillTps ?? null, true)}`,
		`Session TPS: ${formatRate(stats.tps)} (${formatSamples(stats.tpsSamples)})`,
		`Session prefill: ${formatRate(stats.prefillTps, true)} (${formatSamples(stats.prefillSamples)})`,
		`Mean TTFT: ${formatMilliseconds(stats.meanTtftMs)} (${formatSamples(stats.ttftSamples)})`,
		`Tokens: input ${stats.tokens.input} · output ${stats.tokens.output}`,
		`Cache: read ${stats.tokens.cacheRead} · write ${stats.tokens.cacheWrite}`,
		"Prefill is estimated from uncached tokens / TTFT; includes network/queue latency.",
	];
}
