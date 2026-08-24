import * as vscode from 'vscode';
import { getSidebarHtml } from './getHtml';
import { PipelineController } from '../pipeline/pipelineController';

interface InboundMessage {
	type: string;
	text?: string;
	autoMode?: boolean;
	enabled?: boolean;
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

	private async handleMessage(message: InboundMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.view?.webview.postMessage({ type: 'state', state: this.controller.getState() });
				this.view?.webview.postMessage({ type: 'history', entries: this.controller.getHistory() });
				return;
			case 'start':
				await this.controller.start(message.text ?? '', !!message.autoMode);
				return;
			case 'provideInfo':
				await this.controller.submitAdditionalInfo(message.text ?? '');
				return;
			case 'approveRequirements':
				await this.controller.approveRequirements();
				return;
			case 'approveImplementation':
				await this.controller.approveImplementation();
				return;
			case 'requestImplementationChanges':
				await this.controller.requestImplementationChanges(message.text ?? '');
				return;
			case 'approveForPullRequest':
				await this.controller.approveForPullRequest();
				return;
			case 'reimplementAfterVerification':
				await this.controller.reimplementAfterVerification();
				return;
			case 'forceProceedToPullRequest':
				await this.controller.forceProceedToPullRequest();
				return;
			case 'completeUserVerification':
				await this.controller.completeUserVerification();
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
			default:
				return;
		}
	}
}
