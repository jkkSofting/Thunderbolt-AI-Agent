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
		vscode.commands.registerCommand('thunderstorm.showDiff', () => controller.showDiff())
	);
}

export function deactivate(): void {
	// no-op: registered disposables handle cleanup
}
