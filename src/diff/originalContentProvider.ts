import * as vscode from 'vscode';

export const THUNDERSTORM_ORIGINAL_SCHEME = 'thunderstorm-original';

/**
 * Serves the pre-change content of a file so it can be shown as the "left"
 * side of VS Code's native diff view. The content is looked up by the
 * relative file path encoded in the virtual document's path component.
 */
export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;

	set(relativePath: string, content: string): vscode.Uri {
		this.contents.set(relativePath, content);
		return vscode.Uri.from({ scheme: THUNDERSTORM_ORIGINAL_SCHEME, path: `/${relativePath}` });
	}

	clear(): void {
		this.contents.clear();
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const relativePath = uri.path.replace(/^\//, '');
		return this.contents.get(relativePath) ?? '';
	}
}
