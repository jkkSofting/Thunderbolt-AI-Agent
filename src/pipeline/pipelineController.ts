import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig } from '../config';
import { sendPrompt } from '../llm/lmClient';
import { renderTemplate } from '../utils/template';
import { extractJson } from '../utils/json';
import { gatherWorkspaceContext } from '../context/workspaceContext';
import { GitService } from '../git/gitService';
import { OriginalContentProvider, THUNDERSTORM_ORIGINAL_SCHEME } from '../diff/originalContentProvider';
import {
	FileChange,
	ImplementationFile,
	ImplementationResult,
	PipelineState,
	RequirementsCheckResult,
	StepId,
	StepState,
	VerificationResult,
} from '../types';

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
	};
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
	private cts: vscode.CancellationTokenSource | undefined;

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

	private getWorkspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	// ---- Schritt 1: Anforderungsanalyse -----------------------------------

	async start(ticketText: string): Promise<void> {
		const trimmed = ticketText.trim();
		if (!trimmed) {
			return;
		}
		this.state = initialState();
		this.state.ticketText = trimmed;
		this.state.phase = 'running';
		this.additionalInfoHistory = [];
		this.implementationFeedback = undefined;
		this.verificationFeedback = undefined;
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
		this.setStep('requirements', { status: 'active', detail: undefined, items: undefined, error: undefined });
		this.setBusy(true);
		try {
			const config = getConfig();
			const additionalInfo = this.additionalInfoHistory.length
				? `Zusätzliche Informationen des Nutzers:\n${this.additionalInfoHistory.join('\n')}`
				: '';
			const prompt = renderTemplate(config.prompts.requirementsCheck, {
				ticket: this.state.ticketText,
				additionalInfo,
			});
			const response = await sendPrompt(config.models.requirementsCheck, prompt, this.newToken());
			const result = extractJson<RequirementsCheckResult>(response);

			if (result.ready) {
				this.setStep('requirements', { status: 'waitingApproval', detail: result.feedback, items: [] });
			} else {
				this.setStep('requirements', {
					status: 'waitingInput',
					detail: result.feedback,
					items: result.missingDetails ?? [],
				});
			}
		} catch (err) {
			this.handleStepError('requirements', err);
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
		await this.runImplementation();
	}

	async approveImplementation(): Promise<void> {
		if (this.state.steps.implementation.status !== 'waitingApproval') {
			return;
		}
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
		const root = this.getWorkspaceRoot();
		this.setStep('implementation', { status: 'active', detail: undefined, error: undefined });
		this.setBusy(true);
		try {
			if (!root) {
				throw new Error('Kein Workspace-Ordner geöffnet. Bitte öffnen Sie einen Ordner, um Code-Änderungen zu generieren.');
			}
			const config = getConfig();
			const workspaceContext = await gatherWorkspaceContext();
			const additionalInfo = this.buildImplementationFeedbackNote();
			const prompt = renderTemplate(config.prompts.implementation, {
				ticket: this.state.ticketText,
				workspaceContext,
				additionalInfo,
			});
			const response = await sendPrompt(config.models.implementation, prompt, this.newToken());
			const result = extractJson<ImplementationResult>(response);

			const fileChanges = await this.applyFileChanges(root, result.files ?? []);
			this.state.fileChanges = fileChanges;
			this.state.prTitle = result.summary;
			this.state.prExplanation = result.explanation;

			this.setStep('implementation', {
				status: 'waitingApproval',
				detail: result.explanation,
				items: fileChanges.map((f) => f.path),
			});
		} catch (err) {
			this.handleStepError('implementation', err);
		} finally {
			this.setBusy(false);
		}
	}

	private async applyFileChanges(root: string, files: ImplementationFile[]): Promise<FileChange[]> {
		const normalizedRoot = path.resolve(root);
		const changes: FileChange[] = [];
		for (const file of files) {
			const relPath = file.path.replace(/^[/\\]+/, '');
			const absPath = path.resolve(normalizedRoot, relPath);
			if (absPath !== normalizedRoot && !absPath.startsWith(normalizedRoot + path.sep)) {
				throw new Error(`Ungültiger Dateipfad außerhalb des Workspace: "${file.path}"`);
			}
			const absUri = vscode.Uri.file(absPath);
			let originalContent: string | null = null;
			try {
				const bytes = await vscode.workspace.fs.readFile(absUri);
				originalContent = Buffer.from(bytes).toString('utf8');
			} catch {
				originalContent = null;
			}
			await vscode.workspace.fs.writeFile(absUri, Buffer.from(file.content, 'utf8'));
			this.originalContentProvider.set(relPath, originalContent ?? '');
			changes.push({ path: relPath, originalContent, newContent: file.content });
		}
		return changes;
	}

	// ---- Schritt 3: Verifizierung ------------------------------------------

	async reimplementAfterVerification(): Promise<void> {
		if (this.state.steps.verification.status !== 'waitingInput') {
			return;
		}
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
			const response = await sendPrompt(config.models.verification, prompt, this.newToken());
			const result = extractJson<VerificationResult>(response);

			if (result.passed) {
				this.verificationFeedback = undefined;
				this.setStep('verification', { status: 'waitingApproval', detail: result.feedback, items: [] });
			} else {
				this.verificationFeedback = `${result.feedback}\n- ${(result.deviations ?? []).join('\n- ')}`;
				this.setStep('verification', {
					status: 'waitingInput',
					detail: result.feedback,
					items: result.deviations ?? [],
				});
			}
		} catch (err) {
			this.handleStepError('verification', err);
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
		const root = this.getWorkspaceRoot();
		this.setStep('pullRequest', { status: 'active', detail: undefined, error: undefined });
		this.setBusy(true);
		try {
			if (!root) {
				throw new Error('Kein Workspace-Ordner geöffnet.');
			}
			const config = getConfig();
			const git = new GitService(root);

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
			this.handleStepError('pullRequest', err);
		} finally {
			this.setBusy(false);
		}
	}

	// ---- Schritt 5: Nutzer-Abnahme ------------------------------------------

	private async moveToUserVerification(): Promise<void> {
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
		this.originalContentProvider.clear();
		this.emit();
	}

	dispose(): void {
		this.cts?.cancel();
		this.cts?.dispose();
		this.contentProviderRegistration.dispose();
		this.stateEmitter.dispose();
	}
}
