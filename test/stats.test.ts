import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { formatReport, formatStatus } from "../src/format";
import { collectAssistantMessages, measureResponse, summarizeSession } from "../src/stats";

type Usage = AssistantMessage["usage"];

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "fixture response" }],
		api: "mock",
		provider: "fixture-provider",
		model: "fixture-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

function entry(id: string, message: AssistantMessage | UserMessage | ToolResultMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: new Date(1_700_000_000_000).toISOString(), message };
}

describe("measureResponse", () => {
	test("uses whole-request output TPS and uncached-prompt prefill, not decode-only or total-prompt rates", () => {
		const measurement = measureResponse(
			assistant({
				usage: usage({ input: 1000, cacheRead: 8000, cacheWrite: 200, output: 120 }),
				duration: 2000,
				ttft: 500,
			}),
		);

		expect(measurement.tps).toBe(60);
		expect(measurement.prefillTps).toBe(2400);
		expect(measurement.ttftMs).toBe(500);
		expect(measurement.stopReason).toBe("stop");
		expect(measurement.provider).toBe("fixture-provider");
		expect(measurement.model).toBe("fixture-model");
	});
});

describe("summarizeSession", () => {
	const first = assistant({
		usage: usage({ input: 1000, cacheRead: 8000, cacheWrite: 200, output: 120 }),
		duration: 2000,
		ttft: 500,
	});
	const second = assistant({
		usage: usage({ input: 600, output: 30 }),
		duration: 1000,
		ttft: 250,
	});

	test("weights session rates by their denominators and keeps token totals exact", () => {
		const stats = summarizeSession([first, second]);

		expect(stats.responses).toBe(2);
		expect(stats.errors).toBe(0);
		expect(stats.aborts).toBe(0);
		expect(stats.tps).toBe(50);
		expect(stats.tpsSamples).toBe(2);
		expect(stats.prefillTps).toBe(2400);
		expect(stats.prefillSamples).toBe(2);
		expect(stats.meanTtftMs).toBe(375);
		expect(stats.ttftSamples).toBe(2);
		expect(stats.tokens).toEqual({ input: 1600, output: 150, cacheRead: 8000, cacheWrite: 200 });
	});

	test("differs from the arithmetic mean of per-response rates", () => {
		const fast = assistant({ usage: usage({ output: 100 }), duration: 1000 });
		const slow = assistant({ usage: usage({ output: 100 }), duration: 3000 });
		const stats = summarizeSession([fast, slow]);

		expect(measureResponse(fast).tps).toBe(100);
		expect(measureResponse(slow).tps).toBeCloseTo(100 / 3, 10);
		expect(stats.tps).toBe(50);
	});

	test("excludes every unusable duration from the TPS sample", () => {
		const durations = [undefined, 0, -100, Number.NaN, Number.POSITIVE_INFINITY, 50];
		const messages = durations.map(duration =>
			assistant({ usage: usage({ input: 100, output: 100, cacheWrite: 0 }), duration, ttft: 10 }),
		);

		for (const message of messages) {
			expect(measureResponse(message).tps).toBeNull();
		}
		const stats = summarizeSession(messages);
		expect(stats.tps).toBeNull();
		expect(stats.tpsSamples).toBe(0);
	});

	test("requires positive output for TPS but still reports prefill", () => {
		const measurement = measureResponse(
			assistant({ usage: usage({ input: 1000, output: 0 }), duration: 1000, ttft: 100 }),
		);
		const stats = summarizeSession([assistant({ usage: usage({ input: 1000, output: 0 }), duration: 1000, ttft: 100 })]);

		expect(measurement.tps).toBeNull();
		expect(measurement.prefillTps).toBe(10_000);
		expect(stats.tps).toBeNull();
		expect(stats.tpsSamples).toBe(0);
		expect(stats.prefillSamples).toBe(1);
	});

	test("rejects invalid TTFT and TTFT longer than the request", () => {
		const invalidLatencies = [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY];
		for (const ttft of invalidLatencies) {
			const measurement = measureResponse(
				assistant({ usage: usage({ input: 100, output: 50 }), duration: 1000, ttft }),
			);
			expect(measurement.prefillTps).toBeNull();
			expect(measurement.ttftMs).toBeNull();
			expect(measurement.tps).toBe(50);
		}

		const late = measureResponse(
			assistant({ usage: usage({ input: 100, output: 50 }), duration: 1000, ttft: 1500 }),
		);
		expect(late.prefillTps).toBeNull();
		expect(late.ttftMs).toBeNull();
		expect(late.tps).toBe(50);
	});

	test("treats a fully cache-read prompt as unavailable prefill, not zero", () => {
		const measurement = measureResponse(
			assistant({
				usage: usage({ input: 0, cacheRead: 5000, cacheWrite: 0, output: 10 }),
				duration: 1000,
				ttft: 100,
			}),
		);

		expect(measurement.prefillTps).toBeNull();
		expect(measurement.ttftMs).toBe(100);
		expect(measurement.tps).toBe(10);
	});

	test("does not add reasoning tokens to the output numerator", () => {
		const measurement = measureResponse(
			assistant({
				usage: usage({ input: 1000, cacheWrite: 200, output: 120, reasoningTokens: 100 }),
				duration: 2000,
				ttft: 500,
			}),
		);
		const stats = summarizeSession([
			assistant({
				usage: usage({ input: 1000, cacheWrite: 200, output: 120, reasoningTokens: 100 }),
				duration: 2000,
				ttft: 500,
			}),
		]);

		expect(measurement.tps).toBe(60);
		expect(measurement.prefillTps).toBe(2400);
		expect(stats.tokens.output).toBe(120);
		expect(stats.tps).toBe(60);
	});

	test("errors count and keep tokens but measure nothing; aborts measure when their numbers are valid", () => {
		const failed = assistant({
			stopReason: "error",
			usage: usage({ input: 1000, output: 120 }),
			duration: 2000,
			ttft: 500,
		});
		const aborted = assistant({
			stopReason: "aborted",
			usage: usage({ input: 1000, output: 120 }),
			duration: 2000,
			ttft: 500,
		});

		const failure = measureResponse(failed);
		expect(failure.tps).toBeNull();
		expect(failure.prefillTps).toBeNull();
		expect(failure.ttftMs).toBeNull();

		const abort = measureResponse(aborted);
		expect(abort.tps).toBe(60);
		expect(abort.prefillTps).toBe(2000);
		expect(abort.ttftMs).toBe(500);

		const stats = summarizeSession([failed, aborted]);
		expect(stats.responses).toBe(2);
		expect(stats.errors).toBe(1);
		expect(stats.aborts).toBe(1);
		expect(stats.tpsSamples).toBe(1);
		expect(stats.prefillSamples).toBe(1);
		expect(stats.ttftSamples).toBe(1);
		expect(stats.tps).toBe(60);
		expect(stats.tokens).toEqual({ input: 2000, output: 240, cacheRead: 0, cacheWrite: 0 });
	});

	test("malformed buckets add nothing and never produce NaN or Infinity", () => {
		const malformed = assistant({
			usage: {
				input: Number.NaN,
				output: -5,
				cacheRead: Number.POSITIVE_INFINITY,
				cacheWrite: undefined,
				totalTokens: 0,
			} as unknown as Usage,
			duration: 1000,
			ttft: 100,
		});
		const stats = summarizeSession([malformed]);
		const measurement = measureResponse(malformed);

		expect(stats.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(stats.responses).toBe(1);
		expect(stats.tps).toBeNull();
		expect(stats.prefillTps).toBeNull();
		expect(stats.meanTtftMs).toBe(100);
		expect(measurement.tps).toBeNull();
		expect(measurement.prefillTps).toBeNull();
		for (const value of [stats.tps, stats.prefillTps, stats.meanTtftMs, measurement.tps, measurement.prefillTps, measurement.ttftMs]) {
			expect(value === null || Number.isFinite(value)).toBe(true);
		}
	});

	test("empty and untimed history keep counts and tokens without inventing rates", () => {
		const empty = summarizeSession([]);
		expect(empty.responses).toBe(0);
		expect(empty.tps).toBeNull();
		expect(empty.prefillTps).toBeNull();
		expect(empty.meanTtftMs).toBeNull();
		expect(empty.tpsSamples).toBe(0);
		expect(empty.prefillSamples).toBe(0);
		expect(empty.ttftSamples).toBe(0);
		expect(empty.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const untimed = summarizeSession([assistant({ usage: usage({ input: 1000, output: 50 }) })]);
		expect(untimed.responses).toBe(1);
		expect(untimed.tokens).toEqual({ input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 });
		expect(untimed.tps).toBeNull();
		expect(untimed.prefillTps).toBeNull();
		expect(untimed.meanTtftMs).toBeNull();
		expect(untimed.tpsSamples).toBe(0);
	});
});

describe("collectAssistantMessages", () => {
	test("keeps pre-reset and post-compaction assistant messages and skips every other entry type", () => {
		const beforeReset = assistant({ usage: usage({ output: 10 }), duration: 1000 });
		const afterReset = assistant({ usage: usage({ output: 20 }), duration: 1000 });
		const afterCompaction = assistant({ usage: usage({ output: 30 }), duration: 1000 });
		const currentBranch: SessionEntry[] = [
			entry("user-1", {
				role: "user",
				content: "hello",
				timestamp: 1_700_000_000_000,
			}),
			entry("assistant-1", beforeReset),
			{ type: "reset_boundary", id: "reset-1", parentId: "assistant-1", timestamp: "2024-01-01T00:00:00.000Z" },
			entry("assistant-2", afterReset),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "assistant-2",
				timestamp: "2024-01-01T00:00:01.000Z",
				summary: "summary",
				firstKeptEntryId: "assistant-2",
				tokensBefore: 1000,
			},
			entry("tool-1", {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file" }],
				isError: false,
				timestamp: 1_700_000_000_002,
			}),
			entry("assistant-3", afterCompaction),
		];
		const otherBranch = assistant({ usage: usage({ output: 99 }), duration: 1000 });

		const messages = collectAssistantMessages(currentBranch);
		expect(messages).toEqual([beforeReset, afterReset, afterCompaction]);
		expect(messages).not.toContain(otherBranch);

		const stats = summarizeSession(messages);
		expect(stats.responses).toBe(3);
		expect(stats.tokens.output).toBe(60);
		expect(stats.tps).toBe(20);
	});

	test("a branch without assistant messages yields an empty measurement", () => {
		expect(collectAssistantMessages([])).toEqual([]);
		expect(
			collectAssistantMessages([
				{ type: "reset_boundary", id: "reset", parentId: null, timestamp: "2024-01-01T00:00:00.000Z" },
			]),
		).toEqual([]);
	});
});

describe("formatting", () => {
	test("renders the compact status shape and failure markers", () => {
		expect(formatStatus(null)).toBe("Last TPS — · Prefill —");

		const measured = measureResponse(
			assistant({
				usage: usage({ input: 1000, cacheRead: 8000, cacheWrite: 200, output: 120 }),
				duration: 2000,
				ttft: 500,
			}),
		);
		expect(formatStatus(measured)).toBe("Last TPS 60.0 tok/s · Prefill ~2400.0 tok/s");

		const failed = measureResponse(assistant({ stopReason: "error" }));
		expect(formatStatus(failed)).toBe("Last TPS — · Prefill — · error");
		const aborted = measureResponse(assistant({ stopReason: "aborted" }));
		expect(formatStatus(aborted)).toBe("Last TPS — · Prefill — · aborted");
	});

	test("keeps the report to ten lines with weighted rates and sanitized labels", () => {
		const first = assistant({
			usage: usage({ input: 1000, cacheRead: 8000, cacheWrite: 200, output: 120 }),
			duration: 2000,
			ttft: 500,
		});
		const second = assistant({
			usage: usage({ input: 600, output: 30 }),
			duration: 1000,
			ttft: 250,
		});
		const stats = summarizeSession([first, second]);
		const last = measureResponse(assistant({ model: "bad\nmodel\u001b[31m", stopReason: "stop" }));
		const lines = formatReport(stats, last);

		expect(lines).toHaveLength(10);
		expect(lines[0]).toBe("Session statistics (current branch)");
		expect(lines[1]).toBe("Responses: 2 · Errors: 0 · Aborts: 0");
		expect(lines[4]).toBe("Session TPS: 50.0 tok/s (2 samples)");
		expect(lines[5]).toBe("Session prefill: ~2400.0 tok/s (2 samples)");
		expect(lines[6]).toBe("Mean TTFT: 375.0 ms (2 samples)");
		expect(lines[7]).toBe("Tokens: input 1600 · output 150");
		expect(lines[8]).toBe("Cache: read 8000 · write 200");
		expect(lines[2]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(lines[2]).toContain("bad model");
	});

	test("reports empty history without fake numbers", () => {
		const lines = formatReport(summarizeSession([]), null);
		expect(lines).toHaveLength(10);
		expect(lines[1]).toBe("Responses: 0 · Errors: 0 · Aborts: 0");
		expect(lines[2]).toBe("Last: No completed responses");
		expect(lines[3]).toBe("Last TPS: — · Prefill —");
		expect(lines[4]).toBe("Session TPS: — (0 samples)");
		expect(lines[5]).toBe("Session prefill: — (0 samples)");
		expect(lines[6]).toBe("Mean TTFT: — (0 samples)");
		expect(lines[7]).toBe("Tokens: input 0 · output 0");
		expect(lines[8]).toBe("Cache: read 0 · write 0");
	});
});
