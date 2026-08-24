import * as vscode from 'vscode';
import { WORKSPACE_EXCLUDE_GLOB } from '../context/workspaceContext';
import { resolveWorkspacePath } from '../utils/paths';
import { ToolDefinition } from './lmClient';

const MAX_LIST_ENTRIES = 300;
const MAX_FILE_CHARS = 8000;

/** Tools that let the implementation-step model explore and read the workspace on demand,
 *  instead of being limited to the small upfront context snapshot. */
export function createWorkspaceTools(root: string): ToolDefinition[] {
	return [
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
					const absPath = resolveWorkspacePath(root, relPath);
					const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
					const text = Buffer.from(bytes).toString('utf8');
					return text.length > MAX_FILE_CHARS
						? `${text.slice(0, MAX_FILE_CHARS)}\n… (Datei gekürzt, ${text.length} Zeichen insgesamt)`
						: text;
				} catch (err) {
					return `Datei "${relPath}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		},
	];
}
