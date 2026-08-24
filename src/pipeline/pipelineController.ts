import * as vscode from 'vscode';
import * as path from 'path';
import { getPipelineDefinition } from '../config';
import { PromptResult, sendPrompt, sendPromptWithTools } from '../llm/lmClient';
import { createWorkspaceTools } from '../llm/workspaceTools';
import { renderTemplate } from '../utils/template';
import { extractJson } from '../utils/json';
import { gatherWorkspaceContext } from '../context/workspaceContext';
import { GitService } from '../git/gitService';
import { OriginalContentProvider, THUNDERSTORM_ORIGINAL_SCHEME } from '../diff/originalContentProvider';
import { DEFAULT_PIPELINE } from './defaultPipeline';
import {
	AiStageDefinition,
	DebugInfo,
	DebugToolCallInfo,
	FileChange,
	GateVerdict,
	GitPrStageDefinition,
	HistoryEntry,
	PipelineDefinition,
	PipelineState,
	ResolvedModelInfo,
	StageId,
	StageRuntimeState,
	UsageInfo,
	UserApprovalStageDefinition,
} from '../types';

const MAX_HISTORY_ENTRIES = 300;
/** Safety net against a misconfigured retry graph (e.g. two gates retrying each other)
 *  looping effectively forever and burning API calls. */
const MAX_TOTAL_STAGE_RUNS = 100;

const GATE_INSTRUCTION_SUFFIX =
	'\n\nAntworte am Ende zusätzlich mit einem eigenen JSON-Objekt auf einer neuen Zeile (kein Markdown), das dein Ergebnis bewertet:\n{"ok": boolean, "feedback": string, "details": string[]}\n- "ok": true, wenn aus deiner Sicht kein Grund besteht, diesen Schritt zu wiederholen oder auf eine Rückmeldung zu warten.\n- "feedback": kurze, für den Nutzer verständliche Begründung.\n- "details": Liste konkreter Punkte (leer, wenn ok true ist).';

type StageOutcome = { type: 'advance'; nextIndex: number } | { type: 'stop' };

function initialStages(definition: PipelineDefinition): StageRuntimeState[] {
	return definition.stages.map((s) => ({ id: s.id, name: s.name, type: s.type, status: 'pending' }));
}

function initialState(definition: PipelineDefinition): PipelineState {
	return {
		phase: 'idle',
		ticketText: '',
		stages: initialStages(definition),
		fileChanges: [],
		busy: false,
		abortRequested: false,
		autoMode: false,
		debugMode: false,
		usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
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

const EMPTY_USAGE: UsageInfo = { requests: 0, inputTokens: 0, outputTokens: 0 };

function sumUsage(a: UsageInfo, b: UsageInfo): UsageInfo {
	return {
		requests: a.requests + b.requests,
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
	};
}

export class PipelineController implements vscode.Disposable {
	private definition: PipelineDefinition = DEFAULT_PIPELINE;
	private state: PipelineState = initialState(this.definition);
	private readonly stateEmitter = new vscode.EventEmitter<PipelineState>();
	readonly onDidChangeState = this.stateEmitter.event;

	private readonly originalContentProvider = new OriginalContentProvider();
	private readonly contentProviderRegistration: vscode.Disposable;

	private readonly fileChangeMap = new Map<string, FileChange>();
	private readonly gateRetryCounts = new Map<StageId, number>();
	/** Accumulates every round's user-supplied/auto-injected note per stage (never overwritten),
	 *  so a second "Erneut prüfen" round still carries forward what was said in the first. */
	private readonly pendingAdditionalInfo = new Map<StageId, string[]>();
	private contextLog: { stageName: string; text: string }[] = [];
	private lastStageResultText = '';
	private activeRetryJump: { gateIndex: number } | undefined;

	private cts: vscode.CancellationTokenSource | undefined;
	private cancelledByUser = false;
	private abortAfterCurrentStep = false;
	private autoMode = false;

	private usage: UsageInfo = { requests: 0, inputTokens: 0, outputTokens: 0 };

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

	/** Adds one LM call's usage to the pipeline-wide total AND to that stage's own cumulative
	 *  total (a stage can run more than once via retries). `requests` is the real, billable
	 *  unit (one Copilot chat request); the token counts are an estimate. */
	private addUsage(stageId: StageId, usage: UsageInfo): void {
		this.usage = sumUsage(this.usage, usage);
		this.state.usage = this.usage;
		this.state.stages = this.state.stages.map((s) =>
			s.id === stageId ? { ...s, usage: sumUsage(s.usage ?? EMPTY_USAGE, usage) } : s
		);
		this.emit();
	}

	/** Records one AI turn (success or failure) for the History view. `model` (which model
	 *  actually answered) is always kept, even outside Debug-Modus, so "was the right model
	 *  used" can always be checked; `debug` (full prompt/tool-call trace) is only attached when
	 *  the debug mode was on for this turn, so ordinary runs stay lightweight. */
	private recordHistory(entry: {
		stageId: StageId;
		title: string;
		userInput: string;
		result: string;
		configuredModel?: { vendor: string; family: string };
		model?: ResolvedModelInfo;
		usage?: UsageInfo;
		debug?: DebugInfo;
	}): void {
		const full: HistoryEntry = {
			id: `h${++this.historySeq}`,
			timestamp: Date.now(),
			stageId: entry.stageId,
			title: entry.title,
			userInput: entry.userInput,
			result: entry.result,
			configuredModel: entry.configuredModel,
			model: entry.model,
			usage: entry.usage,
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

	private stageIndex(id: StageId): number {
		return this.definition.stages.findIndex((s) => s.id === id);
	}

	private getStageState(id: StageId): StageRuntimeState | undefined {
		return this.state.stages.find((s) => s.id === id);
	}

	private setStageState(id: StageId, patch: Partial<StageRuntimeState>): void {
		this.state.stages = this.state.stages.map((s) => (s.id === id ? { ...s, ...patch } : s));
		this.emit();
	}

	private setBusy(busy: boolean): void {
		this.state.busy = busy;
		this.emit();
	}

	private newToken(): vscode.CancellationToken {
		this.cts?.dispose();
		this.cts = new vscode.CancellationTokenSource();
		return this.cts.token;
	}

	private getWorkspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private addPendingInfo(stageId: StageId, note: string): void {
		const list = this.pendingAdditionalInfo.get(stageId) ?? [];
		list.push(note);
		this.pendingAdditionalInfo.set(stageId, list);
	}

	private mergeFileChange(change: FileChange): void {
		const existing = this.fileChangeMap.get(change.path);
		const originalContent = existing ? existing.originalContent : change.originalContent;
		this.fileChangeMap.set(change.path, { path: change.path, originalContent, newContent: change.newContent });
		this.state.fileChanges = Array.from(this.fileChangeMap.values());
		this.originalContentProvider.set(change.path, originalContent ?? '');
	}

	private formatFileDiffSummary(change: FileChange): string {
		const original = change.originalContent === null ? '(neue Datei)' : truncate(change.originalContent);
		const updated = truncate(change.newContent);
		return `Datei: ${change.path}\n--- vorher ---\n${original}\n--- nachher ---\n${updated}`;
	}

	private formatCumulativeFileChanges(): string {
		if (this.fileChangeMap.size === 0) {
			return '(keine Änderungen bisher)';
		}
		return Array.from(this.fileChangeMap.values())
			.map((f) => this.formatFileDiffSummary(f))
			.join('\n\n');
	}

	private formatContextLog(): string {
		return this.contextLog.map((e) => `### ${e.stageName} ###\n${e.text}`).join('\n\n');
	}

	private derivePrTitle(): string {
		const firstLine = (this.state.ticketText.split('\n')[0] ?? '').trim();
		const truncated = firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
		return `Thunderstorm: ${truncated || 'Automatische Änderung'}`;
	}

	// ---- Abbruch ------------------------------------------------------------

	/** Checks a queued "abort after current step" request. Call at the top of every loop
	 *  iteration in {@link advanceFrom}. Returns true if the run was cancelled and the caller
	 *  must stop immediately. */
	private checkAbortGate(): boolean {
		if (!this.abortAfterCurrentStep) {
			return false;
		}
		this.finishAborted();
		return true;
	}

	private abortCurrentStep(id: StageId): void {
		this.setStageState(id, { status: 'aborted', error: undefined, detail: 'Vom Nutzer abgebrochen.' });
		this.finishAborted();
	}

	private finishAborted(): void {
		this.abortAfterCurrentStep = false;
		this.cancelledByUser = false;
		this.state.stages = this.state.stages.map((s) =>
			s.status === 'pending' || s.status === 'active'
				? { ...s, status: 'skipped', detail: 'Übersprungen: Vorgang wurde vom Nutzer abgebrochen.' }
				: s
		);
		this.state.phase = 'aborted';
		this.state.abortRequested = false;
		this.state.busy = false;
		this.emit();
	}

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

	// ---- Ablaufsteuerung ------------------------------------------------------

	async start(ticketText: string, autoMode: boolean): Promise<void> {
		const trimmed = ticketText.trim();
		if (!trimmed) {
			return;
		}
		this.definition = getPipelineDefinition();
		this.state = initialState(this.definition);
		this.state.ticketText = trimmed;
		this.state.phase = 'running';
		this.state.autoMode = autoMode;
		this.state.debugMode = this.debugMode;
		this.autoMode = autoMode;
		this.fileChangeMap.clear();
		this.gateRetryCounts.clear();
		this.pendingAdditionalInfo.clear();
		this.contextLog = [];
		this.lastStageResultText = '';
		this.activeRetryJump = undefined;
		this.cancelledByUser = false;
		this.abortAfterCurrentStep = false;
		this.usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
		this.originalContentProvider.clear();
		this.emit();
		await this.advanceFrom(0);
	}

	/** Runs stages starting at `index`, auto-continuing (approval-gate/gate-retry permitting)
	 *  until a stage pauses for the user, errors, gets aborted, or the chain runs off the end. */
	private async advanceFrom(index: number): Promise<void> {
		let i = index;
		let totalRuns = 0;
		while (i >= 0 && i < this.definition.stages.length) {
			if (this.checkAbortGate()) {
				return;
			}
			totalRuns++;
			if (totalRuns > MAX_TOTAL_STAGE_RUNS) {
				const stageId = this.definition.stages[i].id;
				this.setStageState(stageId, {
					status: 'error',
					error: `Sicherheitslimit erreicht (${MAX_TOTAL_STAGE_RUNS} automatische Stufen-Durchläufe in einem Lauf) – möglicherweise verweisen zwei Gates zyklisch aufeinander. Abgebrochen.`,
				});
				this.setBusy(false);
				return;
			}
			const outcome = await this.executeStage(i);
			if (outcome.type === 'advance') {
				i = outcome.nextIndex;
				continue;
			}
			return;
		}
		this.finishPipeline();
	}

	private finishPipeline(): void {
		this.state.phase = 'done';
		this.emit();
	}

	private async executeStage(index: number): Promise<StageOutcome> {
		const stage = this.definition.stages[index];
		if (this.activeRetryJump && this.activeRetryJump.gateIndex === index) {
			this.activeRetryJump = undefined;
		}
		switch (stage.type) {
			case 'ai':
				return this.executeAiStage(index, stage);
			case 'gitPr':
				return this.executeGitPrStage(index, stage);
			case 'userApproval':
				return this.executeUserApprovalStage(index, stage);
		}
	}

	// ---- Stage-Typ: ai ---------------------------------------------------------

	private async executeAiStage(index: number, stage: AiStageDefinition): Promise<StageOutcome> {
		// Every round's note (manual or gate-injected) stays in the list — a later round still
		// sees what was said in earlier ones, not just the latest.
		const additionalInfo = (this.pendingAdditionalInfo.get(stage.id) ?? []).join('\n\n');

		let title = stage.name;
		if (this.activeRetryJump !== undefined) {
			const gateStage = this.definition.stages[this.activeRetryJump.gateIndex];
			const count = this.gateRetryCounts.get(gateStage.id) ?? 0;
			title = `${stage.name} (Korrekturversuch ${count}, ausgelöst durch "${gateStage.name}")`;
		}
		const userInput = this.state.ticketText + (additionalInfo ? `\n\n${additionalInfo}` : '');

		this.setStageState(stage.id, { status: 'active', detail: undefined, error: undefined });
		this.setBusy(true);
		try {
			const root = this.getWorkspaceRoot();
			if (stage.tools !== 'none' && !root) {
				throw new Error('Kein Workspace-Ordner geöffnet. Diese Stufe benötigt Dateizugriff.');
			}
			const workspaceContext = stage.includeWorkspaceContext ? await gatherWorkspaceContext() : '';
			let renderedPrompt = renderTemplate(stage.prompt, {
				ticket: this.state.ticketText,
				context: this.formatContextLog(),
				lastResult: this.lastStageResultText,
				fileChanges: this.formatCumulativeFileChanges(),
				workspaceContext,
				additionalInfo,
			});
			if (stage.gate) {
				renderedPrompt += GATE_INSTRUCTION_SUFFIX;
			}

			const token = this.newToken();
			const selector = { vendor: stage.modelVendor, family: stage.modelFamily };
			let promptResult: PromptResult;
			let toolCalls: DebugToolCallInfo[] | undefined;
			if (stage.tools === 'none') {
				promptResult = await sendPrompt(selector, renderedPrompt, token);
			} else {
				const toolsResult = await sendPromptWithTools(
					selector,
					renderedPrompt,
					createWorkspaceTools({
						root: root as string,
						allowWrite: stage.tools === 'readWrite',
						onWrite: (change) => this.mergeFileChange(change),
					}),
					token
				);
				promptResult = toolsResult;
				toolCalls = toolsResult.toolCalls;
			}
			this.addUsage(stage.id, promptResult.usage);

			// If a stage has write access but made zero write_file calls, its final text may
			// just be *describing* a change it never actually applied. Surface that explicitly
			// in what gets carried forward, instead of leaving the next stage (e.g. the
			// verifier) to silently work off a diff that doesn't match the prose.
			const writeFileCalls = (toolCalls ?? []).filter((c) => c.name === 'write_file').length;
			const noWritesWarning =
				stage.tools === 'readWrite' && writeFileCalls === 0
					? '\n\n[Hinweis: Diese Runde hat keine Datei über das write_file-Tool geschrieben. Eine hier beschriebene Änderung wurde also nicht tatsächlich angewendet.]'
					: '';

			let verdict: GateVerdict | undefined;
			let proseText = promptResult.text.trim();
			if (stage.gate) {
				verdict = extractJson<GateVerdict>(promptResult.text);
				const jsonStart = promptResult.text.indexOf('{');
				proseText = jsonStart > 0 ? promptResult.text.slice(0, jsonStart).trim() : verdict.feedback ?? '';
			}
			this.lastStageResultText = (proseText || promptResult.text.trim()) + noWritesWarning;
			this.contextLog.push({ stageName: stage.name, text: this.lastStageResultText });

			let historyResult = this.lastStageResultText;
			if (stage.gate && verdict) {
				const detailsSuffix = verdict.details.length ? ` (${verdict.details.join('; ')})` : '';
				historyResult = `${verdict.ok ? 'OK' : 'Nicht OK'}. ${verdict.feedback}${detailsSuffix}`;
			}
			this.recordHistory({
				stageId: stage.id,
				title,
				userInput,
				result: historyResult,
				configuredModel: { vendor: stage.modelVendor, family: stage.modelFamily },
				model: promptResult.model,
				usage: promptResult.usage,
				debug: {
					model: promptResult.model,
					prompt: renderedPrompt,
					toolCalls,
					rawResponse: promptResult.text,
				},
			});

			if (stage.gate && verdict && !verdict.ok) {
				return this.handleGateFailure(index, stage, verdict);
			}

			const detail = stage.gate ? verdict?.feedback : this.lastStageResultText;
			const items = verdict?.details ?? [];
			const suppressApproval = this.autoMode || this.activeRetryJump !== undefined;
			if (stage.requireApproval && !suppressApproval) {
				this.setStageState(stage.id, { status: 'waitingApproval', detail, items });
				return { type: 'stop' };
			}
			this.setStageState(stage.id, { status: 'completed', detail, items });
			return { type: 'advance', nextIndex: index + 1 };
		} catch (err) {
			if (this.cancelledByUser) {
				this.abortCurrentStep(stage.id);
			} else {
				const message = err instanceof Error ? err.message : String(err);
				this.recordHistory({
					stageId: stage.id,
					title,
					userInput,
					result: `Fehler: ${message}`,
					configuredModel: { vendor: stage.modelVendor, family: stage.modelFamily },
				});
				this.setStageState(stage.id, { status: 'error', error: message });
			}
			return { type: 'stop' };
		} finally {
			this.setBusy(false);
		}
	}

	private handleGateFailure(index: number, stage: AiStageDefinition, verdict: GateVerdict): StageOutcome {
		const gate = stage.gate;
		if (!gate) {
			return { type: 'stop' };
		}
		if (gate.onFail.action === 'pause') {
			this.setStageState(stage.id, { status: 'waitingInput', detail: verdict.feedback, items: verdict.details });
			return { type: 'stop' };
		}

		const { targetStageId, maxAutoRetries } = gate.onFail;
		const targetIndex = this.stageIndex(targetStageId);
		if (targetIndex === -1) {
			this.setStageState(stage.id, {
				status: 'error',
				error: `Ungültige Gate-Konfiguration: Ziel-Stufe "${targetStageId}" existiert nicht.`,
			});
			return { type: 'stop' };
		}

		const count = this.gateRetryCounts.get(stage.id) ?? 0;
		if (count < maxAutoRetries) {
			this.gateRetryCounts.set(stage.id, count + 1);
			this.setStageState(stage.id, {
				status: 'active',
				detail: `${verdict.feedback} Automatischer Korrekturversuch ${count + 1}/${maxAutoRetries} über Stufe "${
					this.definition.stages[targetIndex].name
				}" wird gestartet.`,
				items: verdict.details,
			});
			const feedbackNote = `Ergebnis der Prüfung durch "${stage.name}" (bitte beheben):\n${verdict.feedback}${
				verdict.details.length ? `\n- ${verdict.details.join('\n- ')}` : ''
			}`;
			this.addPendingInfo(targetStageId, feedbackNote);
			this.activeRetryJump = { gateIndex: index };
			return { type: 'advance', nextIndex: targetIndex };
		}

		this.setStageState(stage.id, {
			status: 'waitingInput',
			detail: maxAutoRetries > 0 ? `${verdict.feedback} (maximale Anzahl automatischer Korrekturversuche erreicht)` : verdict.feedback,
			items: verdict.details,
		});
		return { type: 'stop' };
	}

	async submitAdditionalInfo(stageId: string, text: string): Promise<void> {
		const index = this.stageIndex(stageId);
		const stage = this.definition.stages[index];
		if (!stage || stage.type !== 'ai' || this.getStageState(stageId)?.status !== 'waitingInput' || !text.trim()) {
			return;
		}
		this.addPendingInfo(stageId, text.trim());
		await this.advanceFrom(index);
	}

	async requestStageChanges(stageId: string, text: string): Promise<void> {
		const index = this.stageIndex(stageId);
		const stage = this.definition.stages[index];
		if (!stage || stage.type !== 'ai' || this.getStageState(stageId)?.status !== 'waitingApproval' || !text.trim()) {
			return;
		}
		this.addPendingInfo(stageId, text.trim());
		await this.advanceFrom(index);
	}

	async approveStage(stageId: string): Promise<void> {
		const index = this.stageIndex(stageId);
		if (index === -1 || this.getStageState(stageId)?.status !== 'waitingApproval') {
			return;
		}
		this.setStageState(stageId, { status: 'completed' });
		await this.advanceFrom(index + 1);
	}

	async retryGateTarget(stageId: string): Promise<void> {
		const index = this.stageIndex(stageId);
		const stage = this.definition.stages[index];
		if (!stage || stage.type !== 'ai' || !stage.gate || stage.gate.onFail.action !== 'retryStage') {
			return;
		}
		if (this.getStageState(stageId)?.status !== 'waitingInput') {
			return;
		}
		const targetIndex = this.stageIndex(stage.gate.onFail.targetStageId);
		if (targetIndex === -1) {
			return;
		}
		this.setStageState(stageId, { status: 'active', detail: 'Manuell erneut versucht.' });
		await this.advanceFrom(targetIndex);
	}

	async forceGateContinue(stageId: string): Promise<void> {
		const index = this.stageIndex(stageId);
		const current = this.getStageState(stageId);
		if (index === -1 || current?.status !== 'waitingInput') {
			return;
		}
		this.setStageState(stageId, { status: 'completed', detail: `${current.detail ?? ''} (vom Nutzer übersteuert)`.trim() });
		await this.advanceFrom(index + 1);
	}

	/** For a stage paused on "we need more info" (a pause-gate, e.g. the requirements check):
	 *  stop waiting on the user and tell the next AI stage to use its own judgment on whatever
	 *  was left open, instead of blocking on it. The ticket text and every note already given
	 *  in earlier rounds of this stage carry forward as usual — this only skips asking for more. */
	async proceedAutonomously(stageId: string): Promise<void> {
		const index = this.stageIndex(stageId);
		const stage = this.definition.stages[index];
		const current = this.getStageState(stageId);
		if (!stage || stage.type !== 'ai' || current?.status !== 'waitingInput') {
			return;
		}
		this.setStageState(stageId, {
			status: 'completed',
			detail: `${current.detail ?? ''} (Nutzer: nächste Stufe soll offene Punkte selbst entscheiden)`.trim(),
		});
		const nextStage = this.definition.stages[index + 1];
		if (nextStage && nextStage.type === 'ai') {
			const openItems = current.items && current.items.length ? `\nOffene Punkte:\n- ${current.items.join('\n- ')}` : '';
			this.addPendingInfo(
				nextStage.id,
				`Hinweis: Der Nutzer hat "${stage.name}" bewusst ohne weitere Angaben fortgesetzt. Bitte triff für offene bzw. unklare Punkte eigenständig eine sinnvolle Entscheidung, statt nachzufragen.${openItems}`
			);
		}
		await this.advanceFrom(index + 1);
	}

	// ---- Stage-Typ: gitPr -------------------------------------------------------

	private async executeGitPrStage(index: number, stage: GitPrStageDefinition): Promise<StageOutcome> {
		const root = this.getWorkspaceRoot();
		this.setStageState(stage.id, { status: 'active', detail: undefined, error: undefined });
		this.setBusy(true);
		try {
			if (!root) {
				throw new Error('Kein Workspace-Ordner geöffnet.');
			}
			const token = this.newToken();
			const git = new GitService(root, toAbortSignal(token));

			if (!(await git.isRepository())) {
				this.setStageState(stage.id, {
					status: 'skipped',
					detail: 'Kein Git-Repository im Workspace gefunden. Die Änderungen verbleiben als lokale Dateien.',
				});
				return { type: 'advance', nextIndex: index + 1 };
			}

			const notes: string[] = [];
			let branchName: string;
			if (await git.hasCommits()) {
				branchName = `${stage.branchPrefix}${slugify(this.derivePrTitle())}-${Date.now()}`;
				await git.createAndCheckoutBranch(branchName);
			} else {
				branchName = await git.currentBranch();
				notes.push('Repository hat noch keinen initialen Commit; Änderungen werden auf dem aktuellen Branch committet.');
			}
			this.state.branchName = branchName;

			await git.stageAll();
			if (!(await git.hasStagedChanges())) {
				this.setStageState(stage.id, { status: 'skipped', detail: 'Keine Änderungen zum Committen gefunden.' });
				return { type: 'advance', nextIndex: index + 1 };
			}

			const title = this.derivePrTitle();
			const body = this.formatContextLog() || title;
			await git.commit(`${title}\n\n${body}`);
			notes.push(`Commit auf Branch "${branchName}" erstellt.`);

			if (!stage.autoCreatePullRequest) {
				this.setStageState(stage.id, { status: 'skipped', detail: `${notes.join(' ')} Automatische PR-Erstellung ist deaktiviert.` });
				return { type: 'advance', nextIndex: index + 1 };
			}

			if (!(await git.hasRemote())) {
				this.setStageState(stage.id, {
					status: 'skipped',
					detail: `${notes.join(' ')} Kein Git-Remote konfiguriert – Pull Request wird übersprungen.`,
				});
				return { type: 'advance', nextIndex: index + 1 };
			}

			try {
				await git.push(branchName);
				notes.push('Branch gepusht.');
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				this.setStageState(stage.id, {
					status: 'skipped',
					detail: `${notes.join(' ')} Push fehlgeschlagen (${reason}) – Pull Request wird übersprungen. Die Änderungen verbleiben als lokaler Commit.`,
				});
				return { type: 'advance', nextIndex: index + 1 };
			}

			const prResult = await git.createPullRequest(title, body, stage.baseBranch);
			if (prResult.success) {
				this.state.prUrl = prResult.url;
				this.setStageState(stage.id, { status: 'completed', detail: `${notes.join(' ')} Pull Request erstellt: ${prResult.url}` });
			} else {
				this.setStageState(stage.id, {
					status: 'skipped',
					detail: `${notes.join(' ')} Pull Request konnte nicht erstellt werden (${prResult.reason}). Die Änderungen verbleiben als lokaler, gepushter Commit.`,
				});
			}
			return { type: 'advance', nextIndex: index + 1 };
		} catch (err) {
			if (this.cancelledByUser) {
				this.abortCurrentStep(stage.id);
			} else {
				const message = err instanceof Error ? err.message : String(err);
				this.setStageState(stage.id, { status: 'error', error: message });
			}
			return { type: 'stop' };
		} finally {
			this.setBusy(false);
		}
	}

	// ---- Stage-Typ: userApproval -------------------------------------------------

	private async executeUserApprovalStage(index: number, stage: UserApprovalStageDefinition): Promise<StageOutcome> {
		this.setStageState(stage.id, { status: 'waitingApproval', detail: stage.instructions });
		if (index === this.definition.stages.length - 1) {
			this.state.phase = 'done';
		}
		this.emit();
		return { type: 'stop' };
	}

	async completeUserApproval(stageId: string): Promise<void> {
		const index = this.stageIndex(stageId);
		if (index === -1 || this.getStageState(stageId)?.status !== 'waitingApproval') {
			return;
		}
		this.setStageState(stageId, { status: 'completed', detail: 'Vom Nutzer freigegeben.' });
		if (index === this.definition.stages.length - 1) {
			return;
		}
		await this.advanceFrom(index + 1);
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
		const errored = this.state.stages.find((s) => s.status === 'error');
		if (!errored) {
			return;
		}
		// Retrying almost always follows a config fix (wrong model name, bad prompt, ...), so
		// pick up the latest settings rather than blindly replaying the definition that just
		// failed. Only swap it in if the stage shape is unchanged (same ids, same order) —
		// otherwise indices could no longer line up with the in-progress runtime state, so we
		// keep the original definition and let the user reset for a structural change.
		const freshDefinition = getPipelineDefinition();
		const sameShape =
			freshDefinition.stages.length === this.definition.stages.length &&
			freshDefinition.stages.every((s, i) => s.id === this.definition.stages[i].id);
		if (sameShape) {
			this.definition = freshDefinition;
		}
		const index = this.stageIndex(errored.id);
		if (index === -1) {
			return;
		}
		await this.advanceFrom(index);
	}

	reset(): void {
		this.cts?.cancel();
		this.cts?.dispose();
		this.cts = undefined;
		this.definition = getPipelineDefinition();
		this.state = initialState(this.definition);
		this.fileChangeMap.clear();
		this.gateRetryCounts.clear();
		this.pendingAdditionalInfo.clear();
		this.contextLog = [];
		this.lastStageResultText = '';
		this.activeRetryJump = undefined;
		this.cancelledByUser = false;
		this.abortAfterCurrentStep = false;
		this.autoMode = false;
		this.usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
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
