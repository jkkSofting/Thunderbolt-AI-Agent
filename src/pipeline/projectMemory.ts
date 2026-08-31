import * as vscode from 'vscode';
import { StageId } from '../types';

interface ProjectMemoryEntry {
	id: string;
	stageId: StageId;
	stageName: string;
	text: string;
	timestamp: number;
}

const MEMORY_FILE_NAME = 'project-memory.json';
/** Caps how many standing notes accumulate per stage — old ones are dropped oldest-first
 *  once a stage's list grows past this, so the prompt doesn't slowly bloat forever. */
const MAX_ENTRIES_PER_STAGE = 20;

/** Persists user-authored clarification notes (e.g. "Coverage-Tool: JaCoCo", "kein hartes
 *  %-Ziel, Entwickler entscheidet") across pipeline runs and VS Code restarts, so a gate stage
 *  (typically "Anforderungsanalyse") doesn't keep asking about the same project-wide standing
 *  facts on every new ticket. Stored as one JSON file under the workspace's extension storage
 *  folder (`context.storageUri`) — per-project, not committed to git, survives restarts/updates. */
export class ProjectMemoryStore {
	private entries: ProjectMemoryEntry[] = [];
	private loaded = false;
	private seq = 0;

	constructor(private readonly storageUri: vscode.Uri | undefined) {}

	private get fileUri(): vscode.Uri | undefined {
		return this.storageUri ? vscode.Uri.joinPath(this.storageUri, MEMORY_FILE_NAME) : undefined;
	}

	async load(): Promise<void> {
		if (this.loaded || !this.fileUri) {
			this.loaded = true;
			return;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(this.fileUri);
			const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
			if (Array.isArray(parsed)) {
				this.entries = parsed;
				this.seq = this.entries.length;
			}
		} catch {
			// No file yet (first run) or unreadable — start empty; worst case we just ask again.
		} finally {
			this.loaded = true;
		}
	}

	/** Standing notes already established for this stage, oldest first — meant to be prepended
	 *  to a stage's prompt so it treats them as already-known instead of asking again. */
	getForStage(stageId: StageId): string[] {
		return this.entries.filter((e) => e.stageId === stageId).map((e) => e.text);
	}

	async add(stageId: StageId, stageName: string, text: string): Promise<void> {
		await this.load();
		const trimmed = text.trim();
		if (!trimmed || this.entries.some((e) => e.stageId === stageId && e.text === trimmed)) {
			return;
		}
		this.entries.push({ id: `m${++this.seq}`, stageId, stageName, text: trimmed, timestamp: Date.now() });
		const forStage = this.entries.filter((e) => e.stageId === stageId);
		if (forStage.length > MAX_ENTRIES_PER_STAGE) {
			const dropIds = new Set(forStage.slice(0, forStage.length - MAX_ENTRIES_PER_STAGE).map((e) => e.id));
			this.entries = this.entries.filter((e) => !dropIds.has(e.id));
		}
		await this.persist();
	}

	async clear(): Promise<void> {
		await this.load();
		this.entries = [];
		await this.persist();
	}

	private async persist(): Promise<void> {
		if (!this.fileUri || !this.storageUri) {
			return;
		}
		try {
			await vscode.workspace.fs.createDirectory(this.storageUri);
			await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(JSON.stringify(this.entries, null, 2), 'utf8'));
		} catch {
			// Best-effort: losing a write only means a future ticket asks again, not a crash.
		}
	}
}
