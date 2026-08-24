import * as vscode from 'vscode';
import { ModelSelector } from '../config';

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

export async function sendPrompt(
	selector: ModelSelector,
	prompt: string,
	token: vscode.CancellationToken
): Promise<string> {
	const model = await selectModel(selector);
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];

	try {
		const response = await model.sendRequest(messages, {}, token);
		let result = '';
		for await (const fragment of response.text) {
			result += fragment;
		}
		return result;
	} catch (err) {
		if (err instanceof vscode.LanguageModelError) {
			throw new LmError(`Sprachmodell-Fehler (${err.code}): ${err.message}`);
		}
		throw err;
	}
}
