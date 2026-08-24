import * as vscode from 'vscode';

const MAX_OPEN_FILES = 6;
const MAX_CHARS_PER_FILE = 4000;
const MAX_TREE_ENTRIES = 200;
const EXCLUDE_GLOB = '**/{node_modules,dist,out,.git,.vscode-test,coverage}/**';

export async function gatherWorkspaceContext(): Promise<string> {
	const parts: string[] = [];

	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return 'Kein Workspace-Ordner geöffnet.';
	}
	parts.push(`Workspace-Ordner: ${folders.map((f) => f.name).join(', ')}`);

	const files = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_TREE_ENTRIES);
	const relPaths = files
		.map((uri) => vscode.workspace.asRelativePath(uri, folders.length > 1))
		.sort();
	parts.push(`Projektstruktur (Auszug, max. ${MAX_TREE_ENTRIES} Einträge):\n${relPaths.join('\n')}`);

	const openDocs = vscode.workspace.textDocuments.filter(
		(doc) => !doc.isUntitled && doc.uri.scheme === 'file'
	);
	const seen = new Set<string>();
	const snippets: string[] = [];
	for (const doc of openDocs) {
		if (snippets.length >= MAX_OPEN_FILES) {
			break;
		}
		const relPath = vscode.workspace.asRelativePath(doc.uri, folders.length > 1);
		if (seen.has(relPath)) {
			continue;
		}
		seen.add(relPath);
		const text = doc.getText();
		const truncated = text.length > MAX_CHARS_PER_FILE ? `${text.slice(0, MAX_CHARS_PER_FILE)}\n… (gekürzt)` : text;
		snippets.push(`--- ${relPath} ---\n${truncated}`);
	}
	if (snippets.length > 0) {
		parts.push(`Inhalt geöffneter Dateien:\n${snippets.join('\n\n')}`);
	}

	return parts.join('\n\n');
}
