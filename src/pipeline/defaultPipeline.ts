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
				'Du bist ein erfahrener Softwareentwickler. Implementiere die folgende Anforderung im aktuellen Workspace. Nutze die verfügbaren Tools, um dir vor jeder Änderung den tatsächlichen Inhalt der betroffenen Dateien anzusehen: Wenn du nicht schon genau weißt, in welcher Datei etwas steht, nutze zuerst gezielt search_files (Volltextsuche) oder find_symbol (Symbolsuche), um die richtige Stelle zu finden, statt Dateien der Reihe nach zu raten und einzeln mit read_file zu öffnen – das spart bei einfachen, lokal begrenzten Änderungen fast immer viele Tool-Aufrufe. Falls dir ein delegate_search-Tool zur Verfügung steht, nutze es für reine Recherchefragen, statt selbst viele Dateien durchzuforsten. WICHTIG: Jede Code-Änderung MUSS über das write_file-Tool tatsächlich geschrieben werden – eine Änderung nur in deiner Antwort zu beschreiben oder anzukündigen reicht nicht, sie wird sonst nicht angewendet. Das gilt auch, wenn du nur eine bereits vorgeschlagene Korrektur nachträglich anpasst. Lies eine Datei nur erneut, wenn es dafür einen konkreten Grund gibt – nicht routinemäßig zur Kontrolle. Fasse am Ende in Prosa zusammen, was du tatsächlich geschrieben hast und warum.\n\nTicket-Beschreibung:\n{{ticket}}\n\nWorkspace-Kontext:\n{{workspaceContext}}\n\nBisheriger Kontext:\n{{context}}\n\n{{additionalInfo}}',
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
				'Du bist ein sorgfältiger Reviewer. Prüfe anhand des Codes – nicht durch Ausführen oder visuelles Betrachten, das kannst du nicht –, ob die vorgenommenen Code-Änderungen die ursprüngliche Ticket-Beschreibung vollständig und korrekt umsetzen.\n\nWichtig zu deinen Grenzen: Du hast keinen Zugriff auf einen Browser, kannst die Anwendung nicht ausführen und keine Screenshots erstellen oder ansehen – das kann auch die Implementierung nicht, verlange so etwas also nie. Fordere daher NIEMALS Screenshots, visuelle Vergleiche, Videos oder manuelles Ausführen der Anwendung als Voraussetzung für ok: true. Bei rein visuellen/UI-Anforderungen (Layout, Styling, Farben, Abstände, Dark Mode etc.) bewerte ausschließlich, ob der Code (CSS/Styles, Markup, Props, bedingte Logik) die Anforderung plausibel und korrekt umsetzt – wenn ja, reicht das, auch ohne visuellen Beleg.\n\nSei dagegen streng bei allem, was sich tatsächlich im Code nachprüfen lässt: Wurde jeder Teil der Anforderung umgesetzt? Gibt es Logikfehler, Widersprüche zur Anforderung, nur angekündigte statt tatsächlich geschriebene Änderungen, vergessene Dateien, Platzhalter/TODOs oder offensichtlich falsche Werte? Das bleibt weiterhin ein gültiger Grund für ok: false.\n\nUrsprüngliche Ticket-Beschreibung:\n{{ticket}}\n\nBisherige Implementierung:\n{{lastResult}}\n\nGeänderte Dateien:\n{{fileChanges}}\n\n{{additionalInfo}}',
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
