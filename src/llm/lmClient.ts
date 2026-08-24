import * as vscode from 'vscode';
import { ModelSelector } from '../config';
import { DebugToolCallInfo, ResolvedModelInfo } from '../types';

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

export interface PromptResult {
	text: string;
	model: ResolvedModelInfo;
}

export async function sendPrompt(
	selector: ModelSelector,
	prompt: string,
	token: vscode.CancellationToken
): Promise<PromptResult> {
	const model = await selectModel(selector);
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];

	try {
		const response = await model.sendRequest(messages, {}, token);
		let result = '';
		for await (const fragment of response.text) {
			result += fragment;
		}
		return { text: result, model: describeModel(model) };
	} catch (err) {
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
}

export interface PromptWithToolsResult extends PromptResult {
	toolCalls: DebugToolCallInfo[];
}

const MAX_TOOL_ROUNDS = 8;

/**
 * Like {@link sendPrompt}, but lets the model call the given tools (e.g. to read files it
 * needs) before producing its final text answer. Runs an agent loop: request → tool calls →
 * tool results fed back → request again, until the model responds with plain text or the
 * round limit is hit. The full tool-call trace is returned alongside the final text so callers
 * can surface it for debugging.
 */
export async function sendPromptWithTools(
	selector: ModelSelector,
	prompt: string,
	tools: ToolDefinition[],
	token: vscode.CancellationToken
): Promise<PromptWithToolsResult> {
	const model = await selectModel(selector);
	const chatTools: vscode.LanguageModelChatTool[] = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	}));
	const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(prompt)];
	const allToolCalls: DebugToolCallInfo[] = [];

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		let response: vscode.LanguageModelChatResponse;
		try {
			response = await model.sendRequest(messages, { tools: chatTools }, token);
		} catch (err) {
			if (err instanceof vscode.LanguageModelError) {
				throw new LmError(`Sprachmodell-Fehler (${err.code}): ${err.message}`);
			}
			throw err;
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

		if (toolCalls.length === 0) {
			return { text, model: describeModel(model), toolCalls: allToolCalls };
		}

		const assistantContent: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		if (text) {
			assistantContent.push(new vscode.LanguageModelTextPart(text));
		}
		assistantContent.push(...toolCalls);
		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantContent));

		const resultParts: vscode.LanguageModelToolResultPart[] = [];
		for (const call of toolCalls) {
			const tool = tools.find((t) => t.name === call.name);
			let resultText: string;
			try {
				resultText = tool
					? await tool.invoke(call.input as Record<string, unknown>)
					: `Unbekanntes Tool: ${call.name}`;
			} catch (err) {
				resultText = `Fehler beim Ausführen von "${call.name}": ${err instanceof Error ? err.message : String(err)}`;
			}
			allToolCalls.push({ name: call.name, input: call.input, result: resultText });
			resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(resultText)]));
		}
		messages.push(vscode.LanguageModelChatMessage.User(resultParts));
	}

	throw new LmError(
		`Maximale Anzahl an Tool-Aufruf-Runden (${MAX_TOOL_ROUNDS}) erreicht, ohne dass das Modell eine finale Antwort geliefert hat.`
	);
}
