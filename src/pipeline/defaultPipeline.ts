import { PipelineDefinition } from '../types';

/** Recreates the original fixed 5-step Thunderstorm workflow as a stage chain. Kept in sync
 *  with the `thunderstorm.pipeline.stages` default in package.json — this copy is the runtime
 *  fallback used when the setting is unset or fails validation. */
export const DEFAULT_PIPELINE: PipelineDefinition = {
	stages: [
		{
			id: 'requirements',
			type: 'ai',
			name: 'Anforderungsanalyse',
			modelVendor: 'copilot',
			modelFamily: 'gpt-4o',
			tools: 'none',
			includeWorkspaceContext: false,
			requireApproval: true,
			gate: { mode: 'boolean', onFail: { action: 'pause' } },
			prompt:
				'Du bist ein erfahrener Software-Architekt. Bewerte die folgende Ticket-Beschreibung: Ist sie klar, eindeutig und vollständig genug, um von einem Entwickler direkt implementiert zu werden, ohne dass Rückfragen nötig sind?\n\nTicket-Beschreibung:\n{{ticket}}\n\n{{additionalInfo}}',
		},
		{
			id: 'implementation',
			type: 'ai',
			name: 'Implementierung',
			modelVendor: 'copilot',
			modelFamily: 'gpt-4o',
			tools: 'readWrite',
			includeWorkspaceContext: true,
			requireApproval: true,
			prompt:
				'Du bist ein erfahrener Softwareentwickler. Implementiere die folgende Anforderung im aktuellen Workspace. Nutze die verfügbaren Tools (Dateien auflisten/lesen/schreiben), um dir vor jeder Änderung den tatsächlichen Inhalt der betroffenen Dateien anzusehen. WICHTIG: Jede Code-Änderung MUSS über das write_file-Tool tatsächlich geschrieben werden – eine Änderung nur in deiner Antwort zu beschreiben oder anzukündigen reicht nicht, sie wird sonst nicht angewendet. Das gilt auch, wenn du nur eine bereits vorgeschlagene Korrektur nachträglich anpasst. Fasse am Ende in Prosa zusammen, was du tatsächlich geschrieben hast und warum.\n\nTicket-Beschreibung:\n{{ticket}}\n\nWorkspace-Kontext:\n{{workspaceContext}}\n\nBisheriger Kontext:\n{{context}}\n\n{{additionalInfo}}',
		},
		{
			id: 'verification',
			type: 'ai',
			name: 'Verifizierung',
			modelVendor: 'copilot',
			modelFamily: 'gpt-4o',
			tools: 'none',
			includeWorkspaceContext: false,
			requireApproval: true,
			gate: {
				mode: 'boolean',
				onFail: { action: 'retryStage', targetStageId: 'implementation', maxAutoRetries: 2 },
			},
			prompt:
				'Du bist ein sorgfältiger Reviewer. Prüfe, ob die vorgenommenen Code-Änderungen die ursprüngliche Ticket-Beschreibung vollständig und korrekt umsetzen.\n\nUrsprüngliche Ticket-Beschreibung:\n{{ticket}}\n\nBisherige Implementierung:\n{{lastResult}}\n\nGeänderte Dateien:\n{{fileChanges}}\n\n{{additionalInfo}}',
		},
		{
			id: 'pullRequest',
			type: 'gitPr',
			name: 'Pull Request',
			baseBranch: 'main',
			branchPrefix: 'thunderstorm/',
			autoCreatePullRequest: true,
		},
		{
			id: 'userVerification',
			type: 'userApproval',
			name: 'Nutzer-Abnahme',
			instructions: 'Bitte führen Sie lokale Tests aus und prüfen Sie die Änderungen manuell. Geben Sie den Vorgang anschließend frei.',
			onReject: { targetStageId: 'verification' },
		},
	],
};
