import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatReport, formatStatus } from "./format";
import { collectAssistantMessages, measureResponse, summarizeSession, type ResponseMeasurement } from "./stats";

const STATUS_KEY = "live-stats";
const WIDGET_KEY = "live-stats";

/**
 * Keeps a compact footer status and an on-demand report backed by the
 * persisted assistant messages of the current main-agent branch. The factory
 * only registers handlers: plugin installation also invokes it without a
 * session or UI.
 */
export default function liveStats(pi: ExtensionAPI): void {
	let last: ResponseMeasurement | null = null;
	let reportVisible = false;

	const readMessages = (ctx: ExtensionContext): AssistantMessage[] =>
		collectAssistantMessages(ctx.sessionManager.getBranch());

	const showReport = (ctx: ExtensionContext, messages: readonly AssistantMessage[]): void => {
		ctx.ui.setWidget(WIDGET_KEY, formatReport(summarizeSession(messages), last), { placement: "belowEditor" });
	};

	const showStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(STATUS_KEY, formatStatus(last));
	};

	const refresh = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind !== "main") return;
		const messages = readMessages(ctx);
		const latest = messages.at(-1);
		last = latest ? measureResponse(latest) : null;
		if (!ctx.hasUI) return;
		showStatus(ctx);
		if (reportVisible) showReport(ctx, messages);
	};

	pi.on("message_end", (event, ctx) => {
		if (ctx.agent.kind !== "main" || event.message.role !== "assistant") return;
		last = measureResponse(event.message);
		if (ctx.hasUI) showStatus(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main" || !reportVisible || !ctx.hasUI) return;
		showReport(ctx, readMessages(ctx));
	});

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("session_switch", (_event, ctx) => refresh(ctx));
	pi.on("session_branch", (_event, ctx) => refresh(ctx));
	pi.on("session_tree", (_event, ctx) => refresh(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		last = null;
		reportVisible = false;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("live-stats", {
		description: "Show session throughput statistics",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "") {
				if (!ctx.hasUI) return;
				const messages = readMessages(ctx);
				reportVisible = true;
				showReport(ctx, messages);
				return;
			}
			if (command === "off") {
				reportVisible = false;
				if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify("Usage: /live-stats [off]", "warning");
		},
	});
}
