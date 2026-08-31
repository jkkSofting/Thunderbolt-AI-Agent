import * as vscode from 'vscode';
import { ModelSelector } from '../config';
import { DebugToolCallInfo, ImageAttachment, ResolvedModelInfo, UsageInfo } from '../types';

export class LmError extends Error {}

async function selectModel(selector: ModelSelector): Promise<vscode.LanguageModelChat> {
	const models = await vscode.lm.selectChatModels(selector);
	if (models.length === 0) {
		throw new LmError(
			`Kein Sprachmodell gefunden (vendor="${selector.vendor ?? '*'}", family="${selector.family ?? '*'}"). ` +
				'Bitte prüfen Sie, ob GitHub Copilot installiert, angemeldet und die Modellfamilie in den Thunderstorm-Einstellungen korrekt konfiguriert ist.'
		);
	}
	return models[0];
}

function describeModel(model: vscode.LanguageModelChat): ResolvedModelInfo {
	return { vendor: model.vendor, family: model.family, id: model.id, name: model.name };
}

/** Token counting is a best-effort estimate (used only as a relative usage gauge) and must
 *  never abort an otherwise-successful request. */
async function safeCountTokens(model: vscode.LanguageModelChat, text: string, token: vscode.CancellationToken): Promise<number> {
	if (!text) {
		return 0;
	}
	try {
		return await model.countTokens(text, token);
	} catch {
		return 0;
	}
}

export interface PromptResult {
	text: string;
	model: ResolvedModelInfo;
	usage: UsageInfo;
}

/** A live "what is this stage doing right now" event — a request round starting/finishing, or a
 *  tool call starting/finishing. Callers (the pipeline controller) turn these into a per-stage
 *  activity log the UI can show while the stage is active, instead of a static spinner. */
export type StageActivityEvent =
	| { type: 'start'; id: string; label: string }
	| { type: 'end'; id: string; label: string; ok: boolean };

export type StageActivityCallback = (event: StageActivityEvent) => void;

/** Reports usage incrementally (one request's worth at a time) as soon as it's known, instead
 *  of only once the whole call resolves — so a multi-round tool-calling stage can show its
 *  running Copilot-request/token count live instead of only after it finishes. */
export type UsageCallback = (delta: UsageInfo) => void;

function looksLikeToolFailure(result: string): boolean {
	return /^(Fehler|Unbekanntes Tool)/.test(result.trim());
}

/** One round of "assistant calls tool(s) → tool result(s) fed back" in a {@link sendPromptWithTools}
 *  conversation, kept as a ready-to-send message pair plus a short text summary of the same round
 *  (used once the round falls outside the recent-history window — see {@link buildRequestMessages}). */
interface ToolRoundRecord {
	assistant: vscode.LanguageModelChatMessage;
	result: vscode.LanguageModelChatMessage;
	summary: string;
}

/** How many of the most recent tool rounds are sent to the model in full (including full tool
 *  result text, e.g. entire file contents). Older rounds are collapsed into one short summary
 *  line per call instead of resent verbatim. Without this, a long-running stage's conversation
 *  grows without bound — every round resends every earlier round's full history — which both
 *  slows every subsequent request down (more tokens to process each time) and, once the
 *  conversation gets large enough, appears to trigger the Copilot backend mangling the
 *  tool_call/tool_result pairing when it truncates history for the underlying model (surfaced as
 *  "No tool call found for function call output ..."). Bounding history size fixes both. */
const KEEP_FULL_TOOL_ROUNDS = 6;

/** Rounds are folded into the summary in batches of this size rather than one at a time. Folding
 *  one round per request would change the summary text (and therefore the whole prefix sent to
 *  the model) on every single request past {@link KEEP_FULL_TOOL_ROUNDS} — resending a differently
 *  shaped conversation each time even though nothing about the *task* changed. Batching means the
 *  prefix stays byte-identical for stretches of {@link TOOL_ROUND_COMPACTION_BATCH} requests in a
 *  row, which costs nothing (the summary is collapsed either way, at the same final size) and
 *  gives any prefix-level reuse the backend might do a real, stable prefix to reuse. */
const TOOL_ROUND_COMPACTION_BATCH = 3;

function truncateOneLine(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Assembles the message list for one request: the original prompt, a summary of any rounds
 *  that fell outside the recent-history window, then those recent rounds in full. `keepFull: 0`
 *  collapses everything (used as a fallback once we've seen a tool-pairing error from the
 *  backend, to keep the conversation as small/simple as possible for the rest of the call).
 *  Rounds are folded into the summary a batch at a time (see {@link TOOL_ROUND_COMPACTION_BATCH})
 *  so the prefix doesn't reshuffle on every single request once history exceeds `keepFull`. */
function buildRequestMessages(
	initial: vscode.LanguageModelChatMessage,
	rounds: ToolRoundRecord[],
	keepFull: number
): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [initial];
	const overflow = rounds.length - keepFull;
	const foldedCount = keepFull === 0 ? overflow : Math.floor(Math.max(0, overflow) / TOOL_ROUND_COMPACTION_BATCH) * TOOL_ROUND_COMPACTION_BATCH;
	if (foldedCount > 0) {
		const summary = rounds
			.slice(0, foldedCount)
			.map((r) => r.summary)
			.join('\n');
		messages.push(
			vscode.LanguageModelChatMessage.Assistant(
				`[Zusammenfassung bereits erledigter Tool-Aufrufe aus früheren Runden dieser Aufgabe – zur Kürzung des Kontexts nicht mehr im Detail enthalten:]\n${summary}`
			)
		);
	}
	for (const round of rounds.slice(foldedCount)) {
		messages.push(round.assistant, round.result);
	}
	return messages;
}

/** The specific 400 the Copilot backend returns when a tool-result message's call_id doesn't
 *  match any tool call it still has in the (possibly backend-truncated) conversation it sent to
 *  the underlying model. */
function isToolPairingError(err: unknown): boolean {
	if (!(err instanceof vscode.LanguageModelError)) {
		return false;
	}
	return /no tool call found for function call output|invalid_request_body/i.test(err.message ?? '');
}

/** Turns attached screenshots into chat-message data parts. Only meaningful for models with
 *  vision support; if the selected model can't handle images, the API surfaces that as a
 *  regular LanguageModelError, which callers already turn into an LmError. */
function toImageParts(images: ImageAttachment[] | undefined): vscode.LanguageModelDataPart[] {
	if (!images || images.length === 0) {
		return [];
	}
	try {
		return images.map((img) => vscode.LanguageModelDataPart.image(Buffer.from(img.data, 'base64'), img.mimeType));
	} catch {
		// Older VS Code builds don't have LanguageModelDataPart.image at all.
		throw new LmError('Bild-Anhänge werden von der installierten VS-Code-Version nicht unterstützt. Bitte VS Code aktualisieren.');
	}
}

function buildUserContent(prompt: string, images: ImageAttachment[] | undefined): string | Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> {
	const imageParts = toImageParts(images);
	return imageParts.length ? [new vscode.LanguageModelTextPart(prompt), ...imageParts] : prompt;
}

export async function sendPrompt(
	selector: ModelSelector,
	prompt: string,
	token: vscode.CancellationToken,
	onActivity?: StageActivityCallback,
	images?: ImageAttachment[]
): Promise<PromptResult> {
	const model = await selectModel(selector);
	const messages = [vscode.LanguageModelChatMessage.User(buildUserContent(prompt, images))];

	onActivity?.({ type: 'start', id: 'request', label: '🤖 Anfrage an Modell läuft …' });
	try {
		const response = await model.sendRequest(messages, {}, token);
		let result = '';
		for await (const fragment of response.text) {
			result += fragment;
		}
		const [inputTokens, outputTokens] = await Promise.all([
			safeCountTokens(model, prompt, token),
			safeCountTokens(model, result, token),
		]);
		onActivity?.({ type: 'end', id: 'request', label: '✓ Antwort erhalten', ok: true });
		return { text: result, model: describeModel(model), usage: { requests: 1, inputTokens, outputTokens } };
	} catch (err) {
		onActivity?.({ type: 'end', id: 'request', label: '✕ Anfrage fehlgeschlagen', ok: false });
		if (err instanceof vscode.LanguageModelError) {
			throw new LmError(`Sprachmodell-Fehler (${err.code}): ${err.message}`);
		}
		throw err;
	}
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema?: object;
	invoke: (input: Record<string, unknown>) => Promise<string> | string;
	/** Human-readable "what is this call doing" text shown live while the tool runs. Falls back
	 *  to a generic "<name> wird ausgeführt" if omitted. */
	describeCall?: (input: Record<string, unknown>) => string;
	/** Human-readable outcome text once the call finished. Falls back to a generic
	 *  "<name> abgeschlossen"/"fehlgeschlagen" (based on `result`'s content) if omitted. */
	describeResult?: (input: Record<string, unknown>, result: string) => string;
}

export interface PromptWithToolsResult extends PromptResult {
	toolCalls: DebugToolCallInfo[];
}

// No practical cap: the user picks the model and can abort a run at any time (immediately, or
// after the current step) if a call spins unproductively. The one residual risk is an
// unattended Auto-Modus run with a genuinely stuck model — nobody watching to abort — but
// that's an accepted trade-off, not something a fixed number here could meaningfully prevent.
const MAX_TOOL_ROUNDS = Infinity;

/**
 * Like {@link sendPrompt}, but lets the model call the given tools (e.g. to read files it
 * needs) before producing its final text answer. Runs an agent loop: request → tool calls →
 * tool results fed back → request again, until the model responds with plain text or the
 * round limit is hit. The full tool-call trace and per-round usage are returned alongside the
 * final text so callers can surface them for debugging/usage tracking.
 */
export async function sendPromptWithTools(
	selector: ModelSelector,
	prompt: string,
	tools: ToolDefinition[],
	token: vscode.CancellationToken,
	onActivity?: StageActivityCallback,
	onUsage?: UsageCallback,
	images?: ImageAttachment[]
): Promise<PromptWithToolsResult> {
	const model = await selectModel(selector);
	const chatTools: vscode.LanguageModelChatTool[] = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	}));
	const initialMessage = vscode.LanguageModelChatMessage.User(buildUserContent(prompt, images));
	const rounds: ToolRoundRecord[] = [];
	const allToolCalls: DebugToolCallInfo[] = [];
	let requests = 0;
	let inputTokens = await safeCountTokens(model, prompt, token);
	let outputTokens = 0;
	let reportedRequests = 0;
	let reportedInputTokens = 0;
	let reportedOutputTokens = 0;
	// Flipped permanently once the backend has been seen to mangle the tool-call history for
	// this call — from then on every request uses the fully-collapsed history (keepFull: 0)
	// instead of risking the same failure again on the next round too.
	let forceFullCompaction = false;

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		requests++;
		const requestActivityId = `request-${round}`;
		onActivity?.({
			type: 'start',
			id: requestActivityId,
			label: round === 0 ? '🤖 Anfrage an Modell läuft …' : `🤖 Anfrage an Modell (Runde ${round + 1}) läuft …`,
		});
		let response: vscode.LanguageModelChatResponse;
		let compactRetried = false;
		for (;;) {
			try {
				const messages = buildRequestMessages(initialMessage, rounds, forceFullCompaction ? 0 : KEEP_FULL_TOOL_ROUNDS);
				response = await model.sendRequest(messages, { tools: chatTools }, token);
				break;
			} catch (err) {
				if (!compactRetried && !forceFullCompaction && isToolPairingError(err)) {
					// The backend lost track of the tool-call history (most likely because the
					// conversation had grown too large). Collapse everything down to summaries and
					// try this same round once more before giving up.
					forceFullCompaction = true;
					compactRetried = true;
					continue;
				}
				onActivity?.({ type: 'end', id: requestActivityId, label: '✕ Anfrage fehlgeschlagen', ok: false });
				if (err instanceof vscode.LanguageModelError) {
					throw new LmError(
						isToolPairingError(err)
							? `Sprachmodell-Fehler (${err.code}): Die Tool-Aufruf-Historie ist beim Modell-Anbieter außer Tritt geraten (vermutlich durch eine zu groß gewordene Unterhaltung). Bitte "Erneut versuchen" klicken.`
							: `Sprachmodell-Fehler (${err.code}): ${err.message}`
					);
				}
				throw err;
			}
		}

		let text = '';
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push(part);
			}
		}
		outputTokens += await safeCountTokens(model, text, token);
		onActivity?.({
			type: 'end',
			id: requestActivityId,
			label: toolCalls.length
				? `✓ Antwort erhalten (${toolCalls.length} Tool-Aufruf${toolCalls.length === 1 ? '' : 'e'})`
				: '✓ Antwort erhalten',
			ok: true,
		});
		onUsage?.({
			requests: requests - reportedRequests,
			inputTokens: inputTokens - reportedInputTokens,
			outputTokens: outputTokens - reportedOutputTokens,
		});
		reportedRequests = requests;
		reportedInputTokens = inputTokens;
		reportedOutputTokens = outputTokens;

		if (toolCalls.length === 0) {
			return { text, model: describeModel(model), toolCalls: allToolCalls, usage: { requests, inputTokens, outputTokens } };
		}

		const assistantContent: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		if (text) {
			assistantContent.push(new vscode.LanguageModelTextPart(text));
		}
		assistantContent.push(...toolCalls);

		// Independent tool calls within one round (e.g. the model reading three files at once)
		// don't need to wait on each other — running them concurrently instead of one-at-a-time
		// cuts wall-clock time for any round with more than one call, at no extra API/token cost.
		// Order is preserved regardless of which finishes first (Promise.all keeps input order),
		// so the result parts still line up 1:1 with `toolCalls` for the model's callIds.
		const callOutcomes = await Promise.all(
			toolCalls.map(async (call, callIndex) => {
				const tool = tools.find((t) => t.name === call.name);
				const input = call.input as Record<string, unknown>;
				const toolActivityId = `tool-${round}-${callIndex}`;
				onActivity?.({
					type: 'start',
					id: toolActivityId,
					label: tool?.describeCall ? tool.describeCall(input) : `⚙️ Tool "${call.name}" wird ausgeführt …`,
				});
				let resultText: string;
				try {
					resultText = tool ? await tool.invoke(input) : `Unbekanntes Tool: ${call.name}`;
				} catch (err) {
					resultText = `Fehler beim Ausführen von "${call.name}": ${err instanceof Error ? err.message : String(err)}`;
				}
				const ok = !looksLikeToolFailure(resultText);
				onActivity?.({
					type: 'end',
					id: toolActivityId,
					label: tool?.describeResult
						? tool.describeResult(input, resultText)
						: `${ok ? '✓' : '✕'} Tool "${call.name}" ${ok ? 'abgeschlossen' : 'fehlgeschlagen'}`,
					ok,
				});
				return { call, resultText };
			})
		);

		const resultParts: vscode.LanguageModelToolResultPart[] = [];
		const summaryLines: string[] = [];
		let roundToolResultText = '';
		for (const { call, resultText } of callOutcomes) {
			allToolCalls.push({ name: call.name, input: call.input, result: resultText });
			roundToolResultText += `${resultText}\n`;
			resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(resultText)]));
			summaryLines.push(`- ${call.name}(${truncateOneLine(JSON.stringify(call.input ?? {}), 150)}) → ${truncateOneLine(resultText, 150)}`);
		}
		inputTokens += await safeCountTokens(model, roundToolResultText, token);
		rounds.push({
			assistant: vscode.LanguageModelChatMessage.Assistant(assistantContent),
			result: vscode.LanguageModelChatMessage.User(resultParts),
			summary: summaryLines.join('\n'),
		});
	}

	const writtenFiles = allToolCalls.filter((c) => c.name === 'write_file').length;
	throw new LmError(
		`Maximale Anzahl an Tool-Aufruf-Runden (${MAX_TOOL_ROUNDS}) erreicht, ohne dass das Modell eine finale Antwort geliefert hat ` +
			`(${allToolCalls.length} Tool-Aufrufe insgesamt, davon ${writtenFiles}x write_file). Bereits geschriebene Dateien bleiben erhalten – über "Diff anzeigen" bzw. den Befehl "Thunderstorm: Änderungen als Diff anzeigen" einsehbar.`
	);
}
