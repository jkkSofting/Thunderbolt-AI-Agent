import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig } from '../config';
import { sendPrompt, sendPromptWithTools } from '../llm/lmClient';
import { createWorkspaceTools } from '../llm/workspaceTools';
import { renderTemplate } from '../utils/template';
import { extractJson } from '../utils/json';
import { resolveWorkspacePath } from '../utils/paths';
import { gatherWorkspaceContext } from '../context/workspaceContext';
import { GitService } from '../git/gitService';
import { OriginalContentProvider, THUNDERSTORM_ORIGINAL_SCHEME } from '../diff/originalContentProvider';
import {
	DebugInfo,
	FileChange,
	HistoryEntry,
	ImplementationFile,
	ImplementationResult,
	PipelineState,
	RequirementsCheckResult,
	StepId,
	StepState,
	VerificationResult,
} from '../types';

const MAX_HISTORY_ENTRIES = 300;

const STEP_TITLES: Record<StepId, string> = {
	requirements: 'Anforderungsanalyse',
	implementation: 'Implementierung',
	verification: 'Verifizierung',
	pullRequest: 'Pull Request',
	userVerification: 'Nutzer-Abnahme',
};

const STEP_ORDER: StepId[] = ['requirements', 'implementation', 'verification', 'pullRequest', 'userVerification'];

function initialSteps(): Record<StepId, StepState> {
	const steps = {} as Record<StepId, StepState>;
	for (const id of STEP_ORDER) {
		steps[id] = { id, title: STEP_TITLES[id], status: 'pending' };
	}
	return steps;
}

function initialState(): PipelineState {
	return {
		phase: 'idle',
		ticketText: '',
		steps: initialSteps(),
		fileChanges: [],
		busy: false,
		abortRequested: false,
		autoMode: false,
		debugMode: false,
	};
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		const subscription = token.onCancellationRequested(() => {
			controller.abort();
			subscription.dispose();
		});
	}
	return controller.signal;
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'aenderung';
}

function truncate(text: string, max = 3000): string {
	return text.length > max ? `${text.slice(0, max)}\n… (gekürzt)` : text;
}

export class PipelineController implements vscode.Disposable {
	private state: PipelineState = initialState();
	private readonly stateEmitter = new vscode.EventEmitter<PipelineState>();
	readonly onDidChangeState = this.stateEmitter.event;

	private readonly originalContentProvider = new OriginalContentProvider();
	private readonly contentProviderRegistration: vscode.Disposable;

	private additionalInfoHistory: string[] = [];
	private implementationFeedback: string | undefined;
	private verificationFeedback: string | undefined;
	private verificationRetryCount = 0;
	private cts: vscode.CancellationTokenSource | undefined;
	private cancelledByUser = false;
	private abortAfterCurrentStep = false;
	private autoMode = false;
	/** Cumulative per-file diff across every implementation round of the current run, keyed
	 *  by workspace-relative path, so a round that leaves a file untouched doesn't erase the
	 *  diff a previous round produced for it. */
	private readonly fileChangeMap = new Map<string, FileChange>();

	private debugMode = false;
	private history: HistoryEntry[] = [];
	private historySeq = 0;
	private readonly historyEmitter = new vscode.EventEmitter<HistoryEntry[]>();
	readonly onDidChangeHistory = this.historyEmitter.event;
	private readonly outputChannel = vscode.window.createOutputChannel('Thunderstorm');

	constructor() {
		this.contentProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
			THUNDERSTORM_ORIGINAL_SCHEME,
			this.originalContentProvider
		);
	}

	getState(): PipelineState {
		return this.snapshot();
	}

	private snapshot(): PipelineState {
		return JSON.parse(JSON.stringify(this.state));
	}

	private emit(): void {
		this.stateEmitter.fire(this.snapshot());
	}

	getHistory(): HistoryEntry[] {
		return this.history.slice();
	}

	setDebugMode(enabled: boolean): void {
		this.debugMode = enabled;
		this.state.debugMode = enabled;
		this.emit();
	}

	showDebugOutput(): void {
		this.outputChannel.show();
	}

	/** Records one AI turn (success or failure) for the History view. `debug` is only attached
	 *  when the debug mode was on for this turn, so ordinary runs stay lightweight. */
	private recordHistory(entry: {
		step: StepId;
		title: string;
		userInput: string;
		result: string;
		debug?: DebugInfo;
	}): void {
		const full: HistoryEntry = {
			id: `h${++this.historySeq}`,
			timestamp: Date.now(),
			step: entry.step,
			title: entry.title,
			userInput: entry.userInput,
			result: entry.result,
			debug: this.debugMode ? entry.debug : undefined,
		};
		this.history.push(full);
		if (this.history.length > MAX_HISTORY_ENTRIES) {
			this.history.splice(0, this.history.length - MAX_HISTORY_ENTRIES);
		}
		this.historyEmitter.fire(this.history.slice());
		if (full.debug) {
			this.writeDebugOutput(full);
		}
	}

	private writeDebugOutput(entry: HistoryEntry): void {
		if (!entry.debug) {
			return;
		}
		const lines: string[] = [
			`\n=== [${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.title} ===`,
			`Modell: ${entry.debug.model.vendor}/${entry.debug.model.family} (${entry.debug.model.name})`,
			'--- Prompt ---',
			entry.debug.prompt,
		];
		for (const call of entry.debug.toolCalls ?? []) {
			lines.push(`--- Tool-Aufruf: ${call.name}(${JSON.stringify(call.input)}) ---`, call.result);
		}
		lines.push('--- Antwort ---', entry.debug.rawResponse);
		this.outputChannel.appendLine(lines.join('\n'));
	}

	private setStep(id: StepId, patch: Partial<StepState>): void {
		this.state.steps[id] = { ...this.state.steps[id], ...patch };
		this.emit();
	}

	private setBusy(busy: boolean): void {
		this.state.busy = busy;
		this.emit();
	}

	private handleStepError(id: StepId, err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		this.setStep(id, { status: 'error', error: message });
	}

	private newToken(): vscode.CancellationToken {
		this.cts?.dispose();
		this.cts = new vscode.CancellationTokenSource();
		return this.cts.token;
	}

	/** Checks a queued "abort after current step" request. Call at the top of every
	 *  step-transition method (before it marks anything 'active'). Returns true if the
	 *  transition was cancelled and the caller must stop immediately. */
	private checkAbortGate(): boolean {
		if (!this.abortAfterCurrentStep) {
			return false;
		}
		this.finishAborted();
		return true;
	}

	private abortCurrentStep(id: StepId): void {
		this.state.steps[id] = {
			...this.state.steps[id],
			status: 'aborted',
			error: undefined,
			detail: 'Vom Nutzer abgebrochen.',
		};
		this.finishAborted();
	}

	private finishAborted(): void {
		this.abortAfterCurrentStep = false;
		this.cancelledByUser = false;
		for (const id of STEP_ORDER) {
			const status = this.state.steps[id].status;
			if (status === 'pending' || status === 'active') {
				this.state.steps[id] = {
					...this.state.steps[id],
					status: 'skipped',
					detail: 'Übersprungen: Vorgang wurde vom Nutzer abgebrochen.',
				};
			}
		}
		this.state.phase = 'aborted';
		this.state.abortRequested = false;
		this.state.busy = false;
		this.emit();
	}

	/** Cancels the in-flight operation (if any) immediately. */
	abortNow(): void {
		if (this.state.phase !== 'running') {
			return;
		}
		this.cancelledByUser = true;
		this.abortAfterCurrentStep = false;
		if (this.state.busy) {
			this.cts?.cancel();
		} else {
			this.finishAborted();
		}
	}

	/** Lets the current step finish, then stops before the next one starts. */
	requestAbortAfterCurrentStep(): void {
		if (this.state.phase !== 'running') {
			return;
		}
		this.abortAfterCurrentStep = true;
		this.state.abortRequested = true;
		this.emit();
	}

	cancelAbortRequest(): void {
		this.abortAfterCurrentStep = false;
		this.state.abortRequested = false;
		this.emit();
	}

	private getWorkspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	// ---- Schritt 1: Anforderungsanalyse -----------------------------------

	async start(ticketText: string, autoMode: boolean): Promise<void> {
		const trimmed = ticketText.trim();
		if (!trimmed) {
			return;
		}
		this.state = initialState();
		this.state.ticketText = trimmed;
		this.state.phase = 'running';
		this.state.autoMode = autoMode;
		this.state.debugMode = this.debugMode;
		this.autoMode = autoMode;
		this.additionalInfoHistory = [];
		this.implementationFeedback = undefined;
		this.verificationFeedback = undefined;
		this.verificationRetryCount = 0;
		this.cancelledByUser = false;
		this.abortAfterCurrentStep = false;
		this.fileChangeMap.clear();
		this.originalContentProvider.clear();
		this.emit();
		await this.runRequirementsCheck();
	}

	async submitAdditionalInfo(text: string): Promise<void> {
		if (!text.trim() || this.state.steps.requirements.status !== 'waitingInput') {
			return;
		}
		this.additionalInfoHistory.push(text.trim());
		await this.runRequirementsCheck();
	}

	async approveRequirements(): Promise<void> {
		if (this.state.steps.requirements.status !== 'waitingApproval') {
			return;
		}
		this.setStep('requirements', { status: 'completed' });
		await this.runImplementation();
	}

	private async runRequirementsCheck(): Promise<void> {
		if (this.checkAbortGate()) {
			return;
		}
		this.setStep('requirements', { status: 'active', detail: undefined, items: undefined, error: undefined });
		this.setBusy(true);
		const round = this.additionalInfoHistory.length;
		const title = round > 0 ? `Anforderungsanalyse (erneute Prüfung ${round})` : 'Anforderungsanalyse';
		const userInput =
			this.state.ticketText +
			(round > 0 ? `\n\nZusätzliche Informationen des Nutzers:\n${this.additionalInfoHistory.join('\n')}` : '');
		try {
			const config = getConfig();
			const additionalInfo = round
				? `Zusätzliche Informationen des Nutzers:\n${this.additionalInfoHistory.join('\n')}`
				: '';
			const prompt = renderTemplate(config.prompts.requirementsCheck, {
				ticket: this.state.ticketText,
				additionalInfo,
			});
			const promptResult = await sendPrompt(config.models.requirementsCheck, prompt, this.newToken());
			const result = extractJson<RequirementsCheckResult>(promptResult.text);

			this.recordHistory({
				step: 'requirements',
				title,
				userInput,
				result: result.ready
					? `Bereit für Implementierung. ${result.feedback}`
					: `Weitere Informationen nötig: ${(result.missingDetails ?? []).join('; ') || result.feedback}`,
				debug: { model: promptResult.model, prompt, rawResponse: promptResult.text },
			});

			if (result.ready) {
				if (this.autoMode) {
					this.setStep('requirements', { status: 'completed', detail: result.feedback, items: [] });
					await this.runImplementation();
				} else {
					this.setStep('requirements', { status: 'waitingApproval', detail: result.feedback, items: [] });
				}
			} else {
				this.setStep('requirements', {
					status: 'waitingInput',
					detail: result.feedback,
					items: result.missingDetails ?? [],
				});
			}
		} catch (err) {
			if (this.cancelledByUser) {
				this.abortCurrentStep('requirements');
			} else {
				const message = err instanceof Error ? err.message : String(err);
				this.recordHistory({ step: 'requirements', title, userInput, result: `Fehler: ${message}` });
				this.handleStepError('requirements', err);
			}
		} finally {
			this.setBusy(false);
		}
	}

	// ---- Schritt 2: Implementierung ----------------------------------------

	async requestImplementationChanges(feedback: string): Promise<void> {
		if (this.state.steps.implementation.status !== 'waitingApproval') {
			return;
		}
		this.implementationFeedback = feedback.trim();
		this.verificationRetryCount = 0;
		await this.runImplementation();
	}

	async approveImplementation(): Promise<void> {
		if (this.state.steps.implementation.status !== 'waitingApproval') {
			return;
		}
		await this.autoAdvanceToVerification();
	}

	private async autoAdvanceToVerification(): Promise<void> {
		this.setStep('implementation', { status: 'completed' });
		await this.runVerification();
	}

	private buildImplementationFeedbackNote(): string {
		const notes: string[] = [];
		if (this.implementationFeedback) {
			notes.push(`Rückmeldung des Nutzers zur vorherigen Implementierung:\n${this.implementationFeedback}`);
		}
		if (this.verificationFeedback) {
			notes.push(`Ergebnis der letzten Verifizierung (bitte beheben):\n${this.verificationFeedback}`);
		}
		return notes.join('\n\n');
	}

	private async runImplementation(): Promise<void> {
		if (this.checkAbortGate()) {
			return;
		}
		const root = this.getWorkspaceRoot();
		const title =
			this.verificationRetryCount > 0
				? `Implementierung (Korrekturversuch ${this.verificationRetryCount})`
				: 'Implementierung';
		this.setStep('implementation', { status: 'active', detail: undefined, error: undefined });
		this.setBusy(true);
		try {
			if (!root) {
				throw new Error('Kein Workspace-Ordner geöffnet. Bitte öffnen Sie einen Ordner, um Code-Änderungen zu generieren.');
			}
			const config = getConfig();
			const token = this.newToken();
			const workspaceContext = await gatherWorkspaceContext();
			const additionalInfo = this.buildImplementationFeedbackNote();
			const prompt = renderTemplate(config.prompts.implementation, {
				ticket: this.state.ticketText,
				workspaceContext,
				additionalInfo,
			});
			const userInput = this.state.ticketText + (additionalInfo ? `\n\n${additionalInfo}` : '');
			const promptResult = await sendPromptWithTools(
				config.models.implementation,
				prompt,
				createWorkspaceTools(root),
				token
			);
			const result = extractJson<ImplementationResult>(promptResult.text);

			const fileChanges = await this.applyFileChanges(root, result.files ?? []);
			this.state.fileChanges = fileChanges;
			this.state.prTitle = result.summary;
			this.state.prExplanation = result.explanation;

			const changedPaths = (result.files ?? []).map((f) => f.path);
			this.recordHistory({
				step: 'implementation',
				title,
				userInput,
				result: `${result.summary}\n${result.explanation}\nGeänderte Dateien in dieser Runde: ${
					changedPaths.length ? changedPaths.join(', ') : '(keine)'
				}`,
				debug: {
					model: promptResult.model,
					prompt,
					toolCalls: promptResult.toolCalls,
					rawResponse: promptResult.text,
				},
			});

			if (this.autoMode) {
				this.setStep('implementation', {
					status: 'completed',
					detail: result.explanation,
					items: fileChanges.map((f) => f.path),
				});
				await this.runVerification();
			} else {
				this.setStep('implementation', {
					status: 'waitingApproval',
					detail: result.explanation,
					items: fileChanges.map((f) => f.path),
				});
			}
		} catch (err) {
			if (this.cancelledByUser) {
				this.abortCurrentStep('implementation');
			} else {
				const message = err instanceof Error ? err.message : String(err);
				this.recordHistory({
					step: 'implementation',
					title,
					userInput: this.state.ticketText,
					result: `Fehler: ${message}`,
				});
				this.handleStepError('implementation', err);
			}
		} finally {
			this.setBusy(false);
		}
	}

	/** Writes the model's file changes to disk and merges them into the cumulative
	 *  {@link fileChangeMap} for this run, so that a later round which leaves a file
	 *  untouched (or reports no changes at all) doesn't erase an earlier round's diff for it. */
	private async applyFileChanges(root: string, files: ImplementationFile[]): Promise<FileChange[]> {
		for (const file of files) {
			const relPath = file.path.replace(/^[/\\]+/, '');
			const absPath = resolveWorkspacePath(root, relPath);
			const absUri = vscode.Uri.file(absPath);

			const existing = this.fileChangeMap.get(relPath);
			let originalContent: string | null;
			if (existing) {
				originalContent = existing.originalContent;
			} else {
				try {
					const bytes = await vscode.workspace.fs.readFile(absUri);
					originalContent = Buffer.from(bytes).toString('utf8');
				} catch {
					originalContent = null;
				}
			}

			await vscode.workspace.fs.writeFile(absUri, Buffer.from(file.content, 'utf8'));
			this.originalContentProvider.set(relPath, originalContent ?? '');
			this.fileChangeMap.set(relPath, { path: relPath, originalContent, newContent: file.content });
		}
		return Array.from(this.fileChangeMap.values());
	}

	// ---- Schritt 3: Verifizierung ------------------------------------------

	async reimplementAfterVerification(): Promise<void> {
		if (this.state.steps.verification.status !== 'waitingInput') {
			return;
		}
		this.verificationRetryCount = 0;
		await this.runImplementation();
	}

	async approveForPullRequest(): Promise<void> {
		const status = this.state.steps.verification.status;
		if (status !== 'waitingApproval') {
			return;
		}
		this.setStep('verification', { status: 'completed' });
		await this.runPullRequest();
	}

	async forceProceedToPullRequest(): Promise<void> {
		if (this.state.steps.verification.status !== 'waitingInput') {
			return;
		}
		this.setStep('verification', {
			status: 'completed',
			detail: `${this.state.steps.verification.detail ?? ''} (vom Nutzer übersteuert)`.trim(),
		});
		await this.runPullRequest();
	}

	private async runVerification(): Promise<void> {
		if (this.checkAbortGate()) {
			return;
		}
		const title =
			this.verificationRetryCount > 0 ? `Verifizierung (nach Korrekturversuch ${this.verificationRetryCount})` : 'Verifizierung';
		this.setStep('verification', { status: 'active', detail: undefined, error: undefined });
		this.setBusy(true);
		try {
			const config = getConfig();
			const diff = this.state.fileChanges.map((f) => this.formatFileDiffSummary(f)).join('\n\n');
			const prompt = renderTemplate(config.prompts.verification, {
				ticket: this.state.ticketText,
				implementationSummary: `${this.state.prTitle ?? ''}\n${this.state.prExplanation ?? ''}`,
				diff,
			});
			const userInput = `Ticket: ${this.state.ticketText}\n\nZu verifizierende Implementierung: ${this.state.prTitle ?? ''}\n${
				this.state.prExplanation ?? ''
			}`;
			const promptResult = await sendPrompt(config.models.verification, prompt, this.newToken());
			const result = extractJson<VerificationResult>(promptResult.text);

			this.recordHistory({
				step: 'verification',
				title,
				userInput,
				result: result.passed
					? `Bestanden. ${result.feedback}`
					: `Abweichungen gefunden: ${(result.deviations ?? []).join('; ')}. ${result.feedback}`,
				debug: { model: promptResult.model, prompt, rawResponse: promptResult.text },
			});

			if (result.passed) {
				this.verificationFeedback = undefined;
				this.verificationRetryCount = 0;
				if (this.autoMode) {
					this.setStep('verification', { status: 'completed', detail: result.feedback, items: [] });
					await this.runPullRequest();
				} else {
					this.setStep('verification', { status: 'waitingApproval', detail: result.feedback, items: [] });
				}
			} else {
				this.verificationFeedback = `${result.feedback}\n- ${(result.deviations ?? []).join('\n- ')}`;
				const maxRetries = config.verification.maxAutoRetries;

				if (this.verificationRetryCount < maxRetries) {
					this.verificationRetryCount++;
					this.setStep('verification', {
						status: 'active',
						detail: `${result.feedback} Automatischer Korrekturversuch ${this.verificationRetryCount}/${maxRetries} wird gestartet.`,
						items: result.deviations ?? [],
					});

					await this.runImplementation();
					if (this.state.steps.implementation.status === 'waitingApproval') {
						await this.autoAdvanceToVerification();
					}
					return;
				}

				this.setStep('verification', {
					status: 'waitingInput',
					detail:
						maxRetries > 0
							? `${result.feedback} (maximale Anzahl automatischer Korrekturversuche erreicht)`
							: result.feedback,
					items: result.deviations ?? [],
				});
			}
		} catch (err) {
			if (this.cancelledByUser) {
				this.abortCurrentStep('verification');
			} else {
				const message = err instanceof Error ? err.message : String(err);
				this.recordHistory({
					step: 'verification',
					title,
					userInput: this.state.ticketText,
					result: `Fehler: ${message}`,
				});
				this.handleStepError('verification', err);
			}
		} finally {
			this.setBusy(false);
		}
	}

	private formatFileDiffSummary(change: FileChange): string {
		const original = change.originalContent === null ? '(neue Datei)' : truncate(change.originalContent);
		const updated = truncate(change.newContent);
		return `Datei: ${change.path}\n--- vorher ---\n${original}\n--- nachher ---\n${updated}`;
	}

	// ---- Schritt 4: Pull Request --------------------------------------------

	private async runPullRequest(): Promise<void> {
		if (this.checkAbortGate()) {
			return;
		}
		const root = this.getWorkspaceRoot();
		this.setStep('pullRequest', { status: 'active', detail: undefined, error: undefined });
		this.setBusy(true);
		try {
			if (!root) {
				throw new Error('Kein Workspace-Ordner geöffnet.');
			}
			const config = getConfig();
			const token = this.newToken();
			const git = new GitService(root, toAbortSignal(token));

			if (!(await git.isRepository())) {
				this.setStep('pullRequest', {
					status: 'skipped',
					detail: 'Kein Git-Repository im Workspace gefunden. Die Änderungen verbleiben als lokale Dateien.',
				});
				await this.moveToUserVerification();
				return;
			}

			const notes: string[] = [];
			let branchName: string;
			if (await git.hasCommits()) {
				branchName = `${config.git.branchPrefix}${slugify(this.state.prTitle ?? 'aenderung')}-${Date.now()}`;
				await git.createAndCheckoutBranch(branchName);
			} else {
				branchName = await git.currentBranch();
				notes.push('Repository hat noch keinen initialen Commit; Änderungen werden auf dem aktuellen Branch committet.');
			}
			this.state.branchName = branchName;

			await git.stageAll();
			if (!(await git.hasStagedChanges())) {
				this.setStep('pullRequest', { status: 'skipped', detail: 'Keine Änderungen zum Committen gefunden.' });
				await this.moveToUserVerification();
				return;
			}

			const commitMessage = `${this.state.prTitle ?? 'Thunderstorm: Automatische Änderung'}\n\n${this.state.prExplanation ?? ''}`;
			await git.commit(commitMessage);
			notes.push(`Commit auf Branch "${branchName}" erstellt.`);

			if (!config.git.autoCreatePullRequest) {
				this.setStep('pullRequest', {
					status: 'skipped',
					detail: `${notes.join(' ')} Automatische PR-Erstellung ist deaktiviert.`,
				});
				await this.moveToUserVerification();
				return;
			}

			if (!(await git.hasRemote())) {
				this.setStep('pullRequest', {
					status: 'skipped',
					detail: `${notes.join(' ')} Kein Git-Remote konfiguriert – Pull Request wird übersprungen.`,
				});
				await this.moveToUserVerification();
				return;
			}

			try {
				await git.push(branchName);
				notes.push('Branch gepusht.');
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				this.setStep('pullRequest', {
					status: 'skipped',
					detail: `${notes.join(' ')} Push fehlgeschlagen (${reason}) – Pull Request wird übersprungen. Die Änderungen verbleiben als lokaler Commit.`,
				});
				await this.moveToUserVerification();
				return;
			}

			const prBody = `${this.state.prExplanation ?? ''}\n\n---\nVerifizierung: ${this.state.steps.verification.detail ?? ''}`;
			const prResult = await git.createPullRequest(
				this.state.prTitle ?? 'Thunderstorm: Automatische Änderung',
				prBody,
				config.git.baseBranch
			);

			if (prResult.success) {
				this.state.prUrl = prResult.url;
				this.setStep('pullRequest', {
					status: 'completed',
					detail: `${notes.join(' ')} Pull Request erstellt: ${prResult.url}`,
				});
			} else {
				this.setStep('pullRequest', {
					status: 'skipped',
					detail: `${notes.join(' ')} Pull Request konnte nicht erstellt werden (${prResult.reason}). Die Änderungen verbleiben als lokaler, gepushter Commit.`,
				});
			}
			await this.moveToUserVerification();
		} catch (err) {
			if (this.cancelledByUser) {
				this.abortCurrentStep('pullRequest');
			} else {
				this.handleStepError('pullRequest', err);
			}
		} finally {
			this.setBusy(false);
		}
	}

	// ---- Schritt 5: Nutzer-Abnahme ------------------------------------------

	private async moveToUserVerification(): Promise<void> {
		if (this.checkAbortGate()) {
			return;
		}
		this.setStep('userVerification', {
			status: 'waitingApproval',
			detail: 'Bitte führen Sie lokale Tests aus und prüfen Sie die Änderungen manuell. Geben Sie den Vorgang anschließend frei.',
		});
		this.state.phase = 'done';
		this.emit();
	}

	async completeUserVerification(): Promise<void> {
		if (this.state.steps.userVerification.status !== 'waitingApproval') {
			return;
		}
		this.setStep('userVerification', { status: 'completed', detail: 'Vom Nutzer freigegeben.' });
	}

	// ---- Sonstiges ------------------------------------------------------------

	async showDiff(): Promise<void> {
		const root = this.getWorkspaceRoot();
		if (!root || this.state.fileChanges.length === 0) {
			vscode.window.showInformationMessage('Thunderstorm: Es sind aktuell keine Änderungen zum Anzeigen vorhanden.');
			return;
		}

		if (this.state.fileChanges.length === 1) {
			const change = this.state.fileChanges[0];
			const modifiedUri = vscode.Uri.file(path.join(root, change.path));
			const originalUri = this.originalContentProvider.set(change.path, change.originalContent ?? '');
			await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, `Thunderstorm: ${change.path}`);
			return;
		}

		const resources = this.state.fileChanges.map((change) => {
			const modifiedUri = vscode.Uri.file(path.join(root, change.path));
			const originalUri = this.originalContentProvider.set(change.path, change.originalContent ?? '');
			return [modifiedUri, originalUri, modifiedUri] as [vscode.Uri, vscode.Uri, vscode.Uri];
		});
		await vscode.commands.executeCommand('vscode.changes', 'Thunderstorm: Code-Änderungen', resources);
	}

	async retry(): Promise<void> {
		const erroredStep = STEP_ORDER.find((id) => this.state.steps[id].status === 'error');
		if (!erroredStep) {
			return;
		}
		switch (erroredStep) {
			case 'requirements':
				await this.runRequirementsCheck();
				return;
			case 'implementation':
				await this.runImplementation();
				return;
			case 'verification':
				await this.runVerification();
				return;
			case 'pullRequest':
				await this.runPullRequest();
				return;
			case 'userVerification':
				this.setStep('userVerification', { status: 'waitingApproval' });
				return;
		}
	}

	reset(): void {
		this.cts?.cancel();
		this.cts?.dispose();
		this.cts = undefined;
		this.state = initialState();
		this.additionalInfoHistory = [];
		this.implementationFeedback = undefined;
		this.verificationFeedback = undefined;
		this.verificationRetryCount = 0;
		this.cancelledByUser = false;
		this.abortAfterCurrentStep = false;
		this.autoMode = false;
		this.fileChangeMap.clear();
		this.originalContentProvider.clear();
		this.state.debugMode = this.debugMode;
		this.emit();
	}

	dispose(): void {
		this.cts?.cancel();
		this.cts?.dispose();
		this.contentProviderRegistration.dispose();
		this.stateEmitter.dispose();
		this.historyEmitter.dispose();
		this.outputChannel.dispose();
	}
}
