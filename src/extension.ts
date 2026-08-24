import * as vscode from 'vscode';
import { PipelineController } from './pipeline/pipelineController';
import { SidebarProvider } from './webview/sidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
	const controller = new PipelineController();
	const sidebarProvider = new SidebarProvider(context.extensionUri, controller);

	context.subscriptions.push(
		controller,
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider),
		vscode.commands.registerCommand('thunderstorm.focus', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.thunderstorm');
			sidebarProvider.reveal();
		}),
		vscode.commands.registerCommand('thunderstorm.reset', () => controller.reset()),
		vscode.commands.registerCommand('thunderstorm.showDiff', () => controller.showDiff()),
		vscode.commands.registerCommand('thunderstorm.listModels', () => listModels())
	);
}

export function deactivate(): void {
	// no-op: registered disposables handle cleanup
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
	vendor: string;
	family: string;
}

async function listModels(): Promise<void> {
	const models = await vscode.lm.selectChatModels();
	if (models.length === 0) {
		vscode.window.showWarningMessage(
			'Thunderstorm: Keine Sprachmodelle verfügbar. Ist GitHub Copilot Chat installiert und angemeldet?'
		);
		return;
	}

	const items: ModelQuickPickItem[] = models.map((model) => ({
		label: `${model.vendor} / ${model.family}`,
		description: model.name,
		detail: `id: ${model.id} · version: ${model.version} · maxInputTokens: ${model.maxInputTokens}`,
		vendor: model.vendor,
		family: model.family,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Verfügbare Sprachmodelle (vendor / family)',
		placeHolder: 'Modell auswählen, um vendor/family in die Zwischenablage zu kopieren',
	});
	if (!picked) {
		return;
	}
	await vscode.env.clipboard.writeText(`"vendor": "${picked.vendor}",\n"family": "${picked.family}"`);
	vscode.window.showInformationMessage(
		`In Zwischenablage kopiert: vendor="${picked.vendor}", family="${picked.family}"`
	);
}
