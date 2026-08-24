import * as path from 'path';

/** Resolves a workspace-relative path to an absolute path, rejecting anything
 *  (via "..", an absolute path, etc.) that would escape the workspace root. */
export function resolveWorkspacePath(root: string, relativePath: string): string {
	const normalizedRoot = path.resolve(root);
	const cleaned = relativePath.replace(/^[/\\]+/, '');
	const absPath = path.resolve(normalizedRoot, cleaned);
	if (absPath !== normalizedRoot && !absPath.startsWith(normalizedRoot + path.sep)) {
		throw new Error(`Ungültiger Dateipfad außerhalb des Workspace: "${relativePath}"`);
	}
	return absPath;
}
