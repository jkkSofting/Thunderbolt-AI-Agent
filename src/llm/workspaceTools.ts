import * as vscode from 'vscode';
import { WORKSPACE_EXCLUDE_GLOB } from '../context/workspaceContext';
import { resolveWorkspacePath } from '../utils/paths';
import { FileChange } from '../types';
import { ToolDefinition } from './lmClient';

const MAX_LIST_ENTRIES = 300;
const MAX_FILE_CHARS = 8000;

export interface WorkspaceToolsOptions {
	root: string;
	/** Grants the write_file tool in addition to list_files/read_file. */
	allowWrite: boolean;
	/** Called synchronously after each successful write_file call. */
	onWrite: (change: FileChange) => void;
}

/** Tools that let an 'ai' stage explore, read, and (if granted) write the workspace on demand,
 *  instead of being limited to a small upfront context snapshot or a rigid output schema. */
export function createWorkspaceTools(options: WorkspaceToolsOptions): ToolDefinition[] {
	const tools: ToolDefinition[] = [
		{
			name: 'list_files',
			description:
				'Listet workspace-relative Dateipfade, optional gefiltert per Glob-Muster (z. B. "src/**/*.ts"). Nutze dies, um passende Dateien zu finden, bevor du sie liest oder änderst.',
			inputSchema: {
				type: 'object',
				properties: {
					glob: {
						type: 'string',
						description: 'Optionales Glob-Muster relativ zum Workspace-Root. Standard: "**/*".',
					},
				},
			},
			invoke: async (input) => {
				const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : '**/*';
				const files = await vscode.workspace.findFiles(glob, WORKSPACE_EXCLUDE_GLOB, MAX_LIST_ENTRIES);
				const relPaths = files.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
				return relPaths.length > 0 ? relPaths.join('\n') : '(keine Treffer)';
			},
			describeCall: (input) =>
				`🔍 Durchsuche Workspace${typeof input.glob === 'string' && input.glob.trim() ? ` ("${input.glob.trim()}")` : ''} …`,
			describeResult: (_input, result) => {
				if (/^Fehler/.test(result)) {
					return '✕ Workspace-Suche fehlgeschlagen';
				}
				const count = result === '(keine Treffer)' ? 0 : result.split('\n').length;
				return `✓ ${count} Datei(en) gefunden`;
			},
		},
		{
			name: 'read_file',
			description: 'Liest den vollständigen Inhalt einer Datei im Workspace anhand ihres workspace-relativen Pfads.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relativer Dateipfad, z. B. "src/extension.ts".' },
				},
				required: ['path'],
			},
			invoke: async (input) => {
				const relPath = typeof input.path === 'string' ? input.path.trim() : '';
				if (!relPath) {
					return 'Fehler: Es wurde kein "path" angegeben.';
				}
				try {
					const absPath = resolveWorkspacePath(options.root, relPath);
					const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
					const text = Buffer.from(bytes).toString('utf8');
					return text.length > MAX_FILE_CHARS
						? `${text.slice(0, MAX_FILE_CHARS)}\n… (Datei gekürzt, ${text.length} Zeichen insgesamt)`
						: text;
				} catch (err) {
					return `Datei "${relPath}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
			describeCall: (input) => `📖 Lese Datei „${typeof input.path === 'string' ? input.path : '?'}“ …`,
			describeResult: (input, result) => {
				const p = typeof input.path === 'string' ? input.path : '?';
				return /konnte nicht gelesen werden/.test(result)
					? `✕ „${p}“ konnte nicht gelesen werden`
					: `✓ „${p}“ gelesen (${result.length.toLocaleString('de-DE')} Zeichen)`;
			},
		},
	];

	if (options.allowWrite) {
		tools.push({
			name: 'write_file',
			description:
				'Schreibt eine Datei im Workspace (erstellt sie bei Bedarf, überschreibt sie sonst vollständig mit dem angegebenen Inhalt). Nutze dies für jede Datei, die neu angelegt oder geändert werden soll.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relativer Dateipfad, z. B. "src/extension.ts".' },
					content: { type: 'string', description: 'Vollständiger neuer Inhalt der Datei.' },
				},
				required: ['path', 'content'],
			},
			invoke: async (input) => {
				const relPath = typeof input.path === 'string' ? input.path.trim() : '';
				const content = typeof input.content === 'string' ? input.content : undefined;
				if (!relPath || content === undefined) {
					return 'Fehler: "path" und "content" sind erforderlich.';
				}
				try {
					const absPath = resolveWorkspacePath(options.root, relPath);
					const absUri = vscode.Uri.file(absPath);
					let originalContent: string | null;
					try {
						const bytes = await vscode.workspace.fs.readFile(absUri);
						originalContent = Buffer.from(bytes).toString('utf8');
					} catch {
						originalContent = null;
					}
					await vscode.workspace.fs.writeFile(absUri, Buffer.from(content, 'utf8'));
					const cleanPath = relPath.replace(/^[/\\]+/, '');
					options.onWrite({ path: cleanPath, originalContent, newContent: content });
					return `OK: "${cleanPath}" geschrieben (${content.length} Zeichen).`;
				} catch (err) {
					return `Fehler beim Schreiben von "${relPath}": ${err instanceof Error ? err.message : String(err)}`;
				}
			},
			describeCall: (input) => `✏️ Schreibe Datei „${typeof input.path === 'string' ? input.path : '?'}“ …`,
			describeResult: (input, result) => {
				const p = typeof input.path === 'string' ? input.path : '?';
				return /^OK:/.test(result) ? `✓ „${p}“ geschrieben` : `✕ „${p}“ konnte nicht geschrieben werden`;
			},
		});
	}

	return tools;
}
