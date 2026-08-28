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
	/** Optional cheaper/faster model that the 'delegate_search' tool hands narrow exploratory
	 *  sub-questions to (e.g. "which file defines the Button component?"), so this stage's own
	 *  (possibly more expensive) model isn't spent on menial lookup work. The tool is only
	 *  offered when both fields are set — no default is guessed, since which models are cheap
	 *  varies by Copilot plan/availability. Only meaningful when `tools` isn't 'none'. */
	helperModelVendor?: string;
	helperModelFamily?: string;
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
	/** Where "Ablehnen" (reject with a reason) sends the pipeline back to for correction. If
	 *  unset, rejecting falls back to the stage immediately preceding this one. */
	onReject?: { targetStageId: StageId };
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
	/** Cumulative usage across every round this stage has run so far in the current pipeline
	 *  run (a stage can run more than once via retries/gate corrections). Undefined until it
	 *  has made at least one LM call. */
	usage?: UsageInfo;
	/** Live trace of what this stage's current round is doing (model request rounds, tool
	 *  calls) — updated in real time while `status` is 'active', so the pipeline view isn't
	 *  just a static "wird verarbeitet" spinner. Reset to empty at the start of each round;
	 *  persists afterwards as a record of what that round did. */
	activity?: StageActivityEntry[];
}

export interface StageActivityEntry {
	id: string;
	label: string;
	status: 'running' | 'done' | 'error';
}

export interface FileChange {
	path: string;
	originalContent: string | null;
	newContent: string;
}

/** A screenshot/image attached alongside the ticket description, sent to every 'ai' stage's
 *  model call as visual context (e.g. a screenshot of a bug or a UI mockup). `data` is the raw
 *  image bytes, base64-encoded (no `data:` URL prefix). */
export interface ImageAttachment {
	id: string;
	name: string;
	mimeType: string;
	data: string;
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
	images: ImageAttachment[];
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
	/** This one call's own usage (not cumulative) — always recorded, same reasoning as `model`. */
	usage?: UsageInfo;
	debug?: DebugInfo;
	/** Set when this entry is a corrective re-run triggered by another stage's gate feedback
	 *  (or a user rejection) — the id of the history entry that carried that feedback, so the
	 *  UI can show the two sides of the exchange together instead of just adjacent-in-time. */
	causedByEntryId?: string;
}

/** Structured verdict a gated 'ai' stage must end its answer with. */
export interface GateVerdict {
	ok: boolean;
	feedback: string;
	details: string[];
}
