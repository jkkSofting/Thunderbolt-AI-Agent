export type StageId = string;

/** File access granted to an 'ai' stage: none, read-only (list_files/read_file), or
 *  read-write (adds write_file). */
export type StageToolAccess = 'none' | 'read' | 'readWrite';

export interface StageGateConfig {
	mode: 'boolean';
	onFail: { action: 'pause' } | { action: 'retryStage'; targetStageId: StageId; maxAutoRetries: number };
}

export interface AiStageDefinition {
	id: StageId;
	type: 'ai';
	name: string;
	modelVendor: string;
	modelFamily: string;
	/** Task instructions only; placeholders: {{ticket}} {{context}} {{lastResult}}
	 *  {{fileChanges}} {{workspaceContext}} {{additionalInfo}}. The gate JSON-contract
	 *  instruction (when `gate` is set) is appended automatically, not part of this text. */
	prompt: string;
	tools: StageToolAccess;
	includeWorkspaceContext: boolean;
	gate?: StageGateConfig;
	/** Pause for a manual "Weiter"/"Änderungen anfordern" confirmation after a successful
	 *  (non-gated or gate-passed) run. Ignored while auto-mode or an automatic gate retry is
	 *  in progress. */
	requireApproval: boolean;
}

export interface GitPrStageDefinition {
	id: StageId;
	type: 'gitPr';
	name: string;
	baseBranch: string;
	branchPrefix: string;
	autoCreatePullRequest: boolean;
}

export interface UserApprovalStageDefinition {
	id: StageId;
	type: 'userApproval';
	name: string;
	instructions: string;
}

export type StageDefinition = AiStageDefinition | GitPrStageDefinition | UserApprovalStageDefinition;

export interface PipelineDefinition {
	stages: StageDefinition[];
}

export type StageStatus =
	| 'pending'
	| 'active'
	| 'waitingInput'
	| 'waitingApproval'
	| 'completed'
	| 'skipped'
	| 'error'
	| 'aborted';

export interface StageRuntimeState {
	id: StageId;
	name: string;
	type: StageDefinition['type'];
	status: StageStatus;
	detail?: string;
	items?: string[];
	error?: string;
}

export interface FileChange {
	path: string;
	originalContent: string | null;
	newContent: string;
}

export interface UsageInfo {
	/** Number of chat requests sent to the language model — the actual unit GitHub Copilot
	 *  bills "premium requests" against. This is real, not estimated. */
	requests: number;
	/** Token counts from LanguageModelChat.countTokens(); an estimate (the exact tokenizer/
	 *  accounting Copilot bills on isn't exposed to extensions), useful as a relative gauge. */
	inputTokens: number;
	outputTokens: number;
}

export interface PipelineState {
	phase: 'idle' | 'running' | 'done' | 'aborted';
	ticketText: string;
	stages: StageRuntimeState[];
	fileChanges: FileChange[];
	prUrl?: string;
	branchName?: string;
	busy: boolean;
	abortRequested: boolean;
	autoMode: boolean;
	debugMode: boolean;
	usage: UsageInfo;
}

export interface ResolvedModelInfo {
	vendor: string;
	family: string;
	id: string;
	name: string;
}

export interface DebugToolCallInfo {
	name: string;
	input: unknown;
	result: string;
}

export interface DebugInfo {
	model: ResolvedModelInfo;
	prompt: string;
	toolCalls?: DebugToolCallInfo[];
	rawResponse: string;
}

export interface HistoryEntry {
	id: string;
	timestamp: number;
	stageId: StageId;
	title: string;
	userInput: string;
	result: string;
	/** What the stage was configured to use at the moment this call ran (not looked up from
	 *  the current pipeline definition, which may have changed since). */
	configuredModel?: { vendor: string; family: string };
	/** The model that actually answered — always recorded (unlike `debug`, which is only kept
	 *  when Debug-Modus was on), so a "wrong model used" question can always be checked. */
	model?: ResolvedModelInfo;
	debug?: DebugInfo;
}

/** Structured verdict a gated 'ai' stage must end its answer with. */
export interface GateVerdict {
	ok: boolean;
	feedback: string;
	details: string[];
}
