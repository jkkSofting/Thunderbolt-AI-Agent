import * as vscode from 'vscode';
import { AiStageDefinition, GitPrStageDefinition, PipelineDefinition, StageDefinition, UserApprovalStageDefinition } from './types';
import { DEFAULT_PIPELINE } from './pipeline/defaultPipeline';

export interface ModelSelector {
	vendor?: string;
	family?: string;
}

const CONFIG_SECTION = 'thunderstorm';
const STAGES_KEY = 'pipeline.stages';

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function validateAiStage(raw: Record<string, unknown>, index: number): AiStageDefinition | undefined {
	if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name) || !isNonEmptyString(raw.prompt)) {
		console.warn(`Thunderstorm: Stufe ${index} (ai) ist ungültig (id/name/prompt fehlt) und wird ignoriert.`);
		return undefined;
	}
	const tools = raw.tools === 'read' || raw.tools === 'readWrite' ? raw.tools : 'none';
	let gate: AiStageDefinition['gate'];
	if (raw.gate && typeof raw.gate === 'object') {
		const g = raw.gate as Record<string, unknown>;
		const onFail = g.onFail as Record<string, unknown> | undefined;
		if (onFail?.action === 'retryStage' && isNonEmptyString(onFail.targetStageId)) {
			gate = {
				mode: 'boolean',
				onFail: {
					action: 'retryStage',
					targetStageId: onFail.targetStageId,
					maxAutoRetries: typeof onFail.maxAutoRetries === 'number' ? Math.max(0, onFail.maxAutoRetries) : 0,
				},
			};
		} else {
			gate = { mode: 'boolean', onFail: { action: 'pause' } };
		}
	}
	return {
		id: raw.id,
		type: 'ai',
		name: raw.name,
		modelVendor: isNonEmptyString(raw.modelVendor) ? raw.modelVendor : 'copilot',
		modelFamily: isNonEmptyString(raw.modelFamily) ? raw.modelFamily : 'gpt-4o',
		prompt: raw.prompt,
		tools,
		includeWorkspaceContext: raw.includeWorkspaceContext === true,
		requireApproval: raw.requireApproval !== false,
		gate,
	};
}

function validateGitPrStage(raw: Record<string, unknown>, index: number): GitPrStageDefinition | undefined {
	if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name)) {
		console.warn(`Thunderstorm: Stufe ${index} (gitPr) ist ungültig (id/name fehlt) und wird ignoriert.`);
		return undefined;
	}
	return {
		id: raw.id,
		type: 'gitPr',
		name: raw.name,
		baseBranch: isNonEmptyString(raw.baseBranch) ? raw.baseBranch : 'main',
		branchPrefix: isNonEmptyString(raw.branchPrefix) ? raw.branchPrefix : 'thunderstorm/',
		autoCreatePullRequest: raw.autoCreatePullRequest !== false,
	};
}

function validateUserApprovalStage(raw: Record<string, unknown>, index: number): UserApprovalStageDefinition | undefined {
	if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name)) {
		console.warn(`Thunderstorm: Stufe ${index} (userApproval) ist ungültig (id/name fehlt) und wird ignoriert.`);
		return undefined;
	}
	return {
		id: raw.id,
		type: 'userApproval',
		name: raw.name,
		instructions: isNonEmptyString(raw.instructions) ? raw.instructions : 'Bitte prüfen und freigeben.',
	};
}

/** Parses+validates the raw `thunderstorm.pipeline.stages` setting value. Invalid individual
 *  stages are dropped (with a console warning) rather than failing the whole pipeline; if
 *  nothing valid remains, falls back to {@link DEFAULT_PIPELINE}. */
export function parsePipelineDefinition(raw: unknown): PipelineDefinition {
	if (!Array.isArray(raw) || raw.length === 0) {
		return DEFAULT_PIPELINE;
	}
	const stages: StageDefinition[] = [];
	const seenIds = new Set<string>();
	raw.forEach((entry, index) => {
		if (!entry || typeof entry !== 'object') {
			return;
		}
		const record = entry as Record<string, unknown>;
		let stage: StageDefinition | undefined;
		if (record.type === 'ai') {
			stage = validateAiStage(record, index);
		} else if (record.type === 'gitPr') {
			stage = validateGitPrStage(record, index);
		} else if (record.type === 'userApproval') {
			stage = validateUserApprovalStage(record, index);
		} else {
			console.warn(`Thunderstorm: Stufe ${index} hat unbekannten type "${String(record.type)}" und wird ignoriert.`);
		}
		if (!stage) {
			return;
		}
		if (seenIds.has(stage.id)) {
			console.warn(`Thunderstorm: Stufe ${index} hat doppelte id "${stage.id}" und wird ignoriert.`);
			return;
		}
		seenIds.add(stage.id);
		stages.push(stage);
	});
	return stages.length > 0 ? { stages } : DEFAULT_PIPELINE;
}

export function getPipelineDefinition(): PipelineDefinition {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return parsePipelineDefinition(cfg.get(STAGES_KEY));
}

/** Persists the stage list to settings.json (workspace scope if a workspace is open, else
 *  user/global settings), so edits made in the sidebar editor round-trip through the same
 *  file a user could hand-edit. */
export async function savePipelineDefinition(definition: PipelineDefinition): Promise<void> {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const target = vscode.workspace.workspaceFolders?.length
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
	await cfg.update(STAGES_KEY, definition.stages, target);
}
