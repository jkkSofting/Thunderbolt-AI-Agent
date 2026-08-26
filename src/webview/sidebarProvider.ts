import * as vscode from 'vscode';
import { getSidebarHtml } from './getHtml';
import { PipelineController } from '../pipeline/pipelineController';
import { getPipelineDefinition, parsePipelineDefinition, savePipelineDefinition } from '../config';

interface InboundMessage {
	type: string;
	text?: string;
	stageId?: string;
	autoMode?: boolean;
	enabled?: boolean;
	stages?: unknown;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'thunderstorm.sidebar';

	private view: vscode.WebviewView | undefined;

	constructor(private readonly extensionUri: vscode.Uri, private readonly controller: PipelineController) {
		this.controller.onDidChangeState((state) => {
			this.view?.webview.postMessage({ type: 'state', state });
		});
		this.controller.onDidChangeHistory((entries) => {
			this.view?.webview.postMessage({ type: 'history', entries });
		});
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		webviewView.webview.html = getSidebarHtml(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage((message: InboundMessage) => {
			void this.handleMessage(message);
		});
	}

	reveal(): void {
		this.view?.show?.(true);
	}

	private sendPipelineDefinition(): void {
		this.view?.webview.postMessage({ type: 'pipelineDefinition', definition: getPipelineDefinition() });
	}

	private async handleMessage(message: InboundMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.view?.webview.postMessage({ type: 'state', state: this.controller.getState() });
				this.view?.webview.postMessage({ type: 'history', entries: this.controller.getHistory() });
				this.sendPipelineDefinition();
				return;
			case 'start':
				await this.controller.start(message.text ?? '', !!message.autoMode);
				return;
			case 'submitAdditionalInfo':
				if (message.stageId) {
					await this.controller.submitAdditionalInfo(message.stageId, message.text ?? '');
				}
				return;
			case 'approveStage':
				if (message.stageId) {
					await this.controller.approveStage(message.stageId);
				}
				return;
			case 'requestStageChanges':
				if (message.stageId) {
					await this.controller.requestStageChanges(message.stageId, message.text ?? '');
				}
				return;
			case 'retryGateTarget':
				if (message.stageId) {
					await this.controller.retryGateTarget(message.stageId);
				}
				return;
			case 'forceGateContinue':
				if (message.stageId) {
					await this.controller.forceGateContinue(message.stageId);
				}
				return;
			case 'proceedAutonomously':
				if (message.stageId) {
					await this.controller.proceedAutonomously(message.stageId);
				}
				return;
			case 'completeUserApproval':
				if (message.stageId) {
					await this.controller.completeUserApproval(message.stageId);
				}
				return;
			case 'rejectUserApproval':
				if (message.stageId) {
					await this.controller.rejectUserApproval(message.stageId, message.text ?? '');
				}
				return;
			case 'showDiff':
				await this.controller.showDiff();
				return;
			case 'retry':
				await this.controller.retry();
				return;
			case 'abortNow':
				this.controller.abortNow();
				return;
			case 'requestAbortAfterCurrentStep':
				this.controller.requestAbortAfterCurrentStep();
				return;
			case 'cancelAbortRequest':
				this.controller.cancelAbortRequest();
				return;
			case 'setDebugMode':
				this.controller.setDebugMode(!!message.enabled);
				return;
			case 'showDebugOutput':
				this.controller.showDebugOutput();
				return;
			case 'openPr':
				if (message.text) {
					await vscode.env.openExternal(vscode.Uri.parse(message.text));
				}
				return;
			case 'reset':
				this.controller.reset();
				return;
			case 'requestPipelineDefinition':
				this.sendPipelineDefinition();
				return;
			case 'savePipelineDefinition': {
				const submittedCount = Array.isArray(message.stages) ? message.stages.length : 0;
				let definition;
				let errorMessage: string | undefined;
				try {
					definition = parsePipelineDefinition(message.stages);
					await savePipelineDefinition(definition);
				} catch (err) {
					errorMessage = err instanceof Error ? err.message : String(err);
				}
				this.sendPipelineDefinition();
				const droppedCount = definition && submittedCount > 0 ? submittedCount - definition.stages.length : 0;
				this.view?.webview.postMessage({ type: 'saveResult', ok: !errorMessage, droppedCount, errorMessage });
				if (errorMessage) {
					vscode.window.showErrorMessage(`Thunderstorm: Pipeline-Konfiguration konnte nicht gespeichert werden: ${errorMessage}`);
				} else if (droppedCount > 0) {
					vscode.window.showWarningMessage(
						`Thunderstorm: ${droppedCount} von ${submittedCount} Stufe(n) waren ungültig und wurden beim Speichern verworfen. Details in der Konsole "Thunderstorm" (Hilfe → Toggle Developer Tools) bzw. den Extension-Host-Logs.`
					);
				} else {
					vscode.window.showInformationMessage('Thunderstorm: Pipeline-Konfiguration gespeichert.');
				}
				return;
			}
			default:
				return;
		}
	}
}
