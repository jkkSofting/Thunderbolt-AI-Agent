export type StepId = 'requirements' | 'implementation' | 'verification' | 'pullRequest' | 'userVerification';

export type StepStatus =
	| 'pending'
	| 'active'
	| 'waitingInput'
	| 'waitingApproval'
	| 'completed'
	| 'skipped'
	| 'error'
	| 'aborted';

export interface StepState {
	id: StepId;
	title: string;
	status: StepStatus;
	detail?: string;
	items?: string[];
	error?: string;
}

export interface FileChange {
	path: string;
	originalContent: string | null;
	newContent: string;
}

export interface PipelineState {
	phase: 'idle' | 'running' | 'done' | 'aborted';
	ticketText: string;
	steps: Record<StepId, StepState>;
	fileChanges: FileChange[];
	prTitle?: string;
	prExplanation?: string;
	prUrl?: string;
	branchName?: string;
	busy: boolean;
	abortRequested: boolean;
	autoMode: boolean;
	debugMode: boolean;
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
	step: StepId;
	title: string;
	userInput: string;
	result: string;
	debug?: DebugInfo;
}

export interface RequirementsCheckResult {
	ready: boolean;
	feedback: string;
	missingDetails: string[];
}

export interface ImplementationFile {
	path: string;
	content: string;
}

export interface ImplementationResult {
	summary: string;
	explanation: string;
	files: ImplementationFile[];
}

export interface VerificationResult {
	passed: boolean;
	feedback: string;
	deviations: string[];
}
