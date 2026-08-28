import * as vscode from 'vscode';
import { WORKSPACE_EXCLUDE_GLOB } from '../context/workspaceContext';
import { resolveWorkspacePath } from '../utils/paths';
import { ModelSelector } from '../config';
import { FileChange } from '../types';
import { StageActivityCallback, StageActivityEvent, ToolDefinition, UsageCallback, sendPromptWithTools } from './lmClient';

const MAX_LIST_ENTRIES = 300;
const MAX_FILE_CHARS = 8000;
const MAX_SEARCH_FILES = 400;
const MAX_SEARCH_MATCHES = 60;
const MAX_MATCH_LINE_CHARS = 200;
const MAX_SYMBOL_RESULTS = 30;

export interface WorkspaceToolsOptions {
	root: string;
	/** Grants list_files/read_file/search_files/find_symbol to the calling model directly. A
	 *  stage can have this off and still get a 'delegate_search' tool (see `helper`) — the model
	 *  then explores the workspace only by asking the helper, never directly itself. */
	allowRead: boolean;
	/** Grants the write_file tool in addition. Only meaningful together with `allowRead`. */
	allowWrite: boolean;
	/** Called synchronously after each successful write_file call. */
	onWrite: (change: FileChange) => void;
	/** If set, adds a 'delegate_search' tool that hands narrow exploratory questions (e.g. "which
	 *  file defines the Button component?") to this cheaper/faster model instead of spending the
	 *  stage's own model on menial lookup work. The delegate gets its own read-only tool set (no
	 *  write access, no further delegation) and its activity/usage is reported through the same
	 *  callbacks as the calling stage, namespaced so events don't collide with the caller's own. */
	helper?: {
		selector: ModelSelector;
		token: vscode.CancellationToken;
		onActivity?: StageActivityCallback;
		onUsage?: UsageCallback;
	};
}

/** Tools that let an 'ai' stage explore, read, and (if granted) write the workspace on demand,
 *  instead of being limited to a small upfront context snapshot or a rigid output schema. */
export function createWorkspaceTools(options: WorkspaceToolsOptions): ToolDefinition[] {
	const tools: ToolDefinition[] = [];

	if (options.allowRead) {
		tools.push(
		{
			name: 'list_files',
			description:
				'Listet workspace-relative Dateipfade, optional gefiltert per Glob-Muster (z. B. "src/**/*.ts"). Nutze dies, um passende Dateien zu finden, bevor du sie liest oder änderst.',
			inputSchema: {
				type: 'object',
				properties: {
					glob: {
						type: 'string',
						description: 'Optionales Glob-Muster relativ zum Workspace-Root. Standard: "**/*".',
					},
				},
			},
			invoke: async (input) => {
				const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : '**/*';
				const files = await vscode.workspace.findFiles(glob, WORKSPACE_EXCLUDE_GLOB, MAX_LIST_ENTRIES);
				const relPaths = files.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
				return relPaths.length > 0 ? relPaths.join('\n') : '(keine Treffer)';
			},
			describeCall: (input) =>
				`🔍 Durchsuche Workspace${typeof input.glob === 'string' && input.glob.trim() ? ` ("${input.glob.trim()}")` : ''} …`,
			describeResult: (_input, result) => {
				if (/^Fehler/.test(result)) {
					return '✕ Workspace-Suche fehlgeschlagen';
				}
				const count = result === '(keine Treffer)' ? 0 : result.split('\n').length;
				return `✓ ${count} Datei(en) gefunden`;
			},
		},
		{
			name: 'read_file',
			description: 'Liest den vollständigen Inhalt einer Datei im Workspace anhand ihres workspace-relativen Pfads.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relativer Dateipfad, z. B. "src/extension.ts".' },
				},
				required: ['path'],
			},
			invoke: async (input) => {
				const relPath = typeof input.path === 'string' ? input.path.trim() : '';
				if (!relPath) {
					return 'Fehler: Es wurde kein "path" angegeben.';
				}
				try {
					const absPath = resolveWorkspacePath(options.root, relPath);
					const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
					const text = Buffer.from(bytes).toString('utf8');
					return text.length > MAX_FILE_CHARS
						? `${text.slice(0, MAX_FILE_CHARS)}\n… (Datei gekürzt, ${text.length} Zeichen insgesamt)`
						: text;
				} catch (err) {
					return `Datei "${relPath}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
			describeCall: (input) => `📖 Lese Datei „${typeof input.path === 'string' ? input.path : '?'}“ …`,
			describeResult: (input, result) => {
				const p = typeof input.path === 'string' ? input.path : '?';
				return /konnte nicht gelesen werden/.test(result)
					? `✕ „${p}“ konnte nicht gelesen werden`
					: `✓ „${p}“ gelesen (${result.length.toLocaleString('de-DE')} Zeichen)`;
			},
		},
		{
			name: 'search_files',
			description:
				'Durchsucht den INHALT aller Workspace-Dateien (nicht nur Dateinamen) nach einem Text und liefert Fundstellen als "Datei:Zeile: Inhalt" zurück. Nutze dies, um die richtige Datei/Stelle gezielt zu finden (z. B. einen Button, eine CSS-Klasse, einen Funktionsnamen), statt Dateien der Reihe nach zu raten und einzeln mit read_file zu öffnen – das spart in der Regel viele Tool-Aufrufe.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Suchtext (einfache Zeichenkette, Groß-/Kleinschreibung wird ignoriert).' },
					glob: {
						type: 'string',
						description: 'Optionales Glob-Muster zur Eingrenzung, z. B. "**/*.{ts,tsx,css}". Standard: "**/*".',
					},
				},
				required: ['query'],
			},
			invoke: async (input) => {
				const query = typeof input.query === 'string' ? input.query.trim() : '';
				if (!query) {
					return 'Fehler: Es wurde kein "query" angegeben.';
				}
				const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : '**/*';
				const files = await vscode.workspace.findFiles(glob, WORKSPACE_EXCLUDE_GLOB, MAX_SEARCH_FILES);
				const needle = query.toLowerCase();
				const matches: string[] = [];
				for (const uri of files) {
					if (matches.length >= MAX_SEARCH_MATCHES) {
						break;
					}
					let text: string;
					try {
						const bytes = await vscode.workspace.fs.readFile(uri);
						text = Buffer.from(bytes).toString('utf8');
					} catch {
						continue;
					}
					if (!text.toLowerCase().includes(needle)) {
						continue;
					}
					const relPath = vscode.workspace.asRelativePath(uri, false);
					const lines = text.split('\n');
					for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
						if (lines[i].toLowerCase().includes(needle)) {
							matches.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, MAX_MATCH_LINE_CHARS)}`);
						}
					}
				}
				return matches.length > 0
					? matches.join('\n')
					: `Keine Treffer für "${query}"${glob !== '**/*' ? ` (Muster "${glob}")` : ''}.`;
			},
			describeCall: (input) => `🔎 Durchsuche Dateiinhalte nach „${typeof input.query === 'string' ? input.query : '?'}“ …`,
			describeResult: (input, result) => {
				const q = typeof input.query === 'string' ? input.query : '?';
				return /^Keine Treffer/.test(result)
					? `– keine Treffer für „${q}“`
					: `✓ Treffer für „${q}“ gefunden (${result.split('\n').length} Zeile(n))`;
			},
		},
		{
			name: 'find_symbol',
			description:
				'Sucht Code-Symbole (Funktionen, Klassen, Komponenten, Variablen …) im Workspace über die Sprachintelligenz von VS Code – präziser als reine Textsuche, weil echte Definitionen statt nur Textvorkommen gefunden werden. Nutze dies z. B. um herauszufinden, wo eine Komponente/Funktion/Klasse definiert ist. Braucht einen aktiven Sprachserver für die jeweilige Sprache; liefert sonst keine Treffer.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Name oder Teil-Name des gesuchten Symbols, z. B. "Button" oder "handleSubmit".' },
				},
				required: ['query'],
			},
			invoke: async (input) => {
				const query = typeof input.query === 'string' ? input.query.trim() : '';
				if (!query) {
					return 'Fehler: Es wurde kein "query" angegeben.';
				}
				try {
					const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
						'vscode.executeWorkspaceSymbolProvider',
						query
					);
					if (!symbols || symbols.length === 0) {
						return `Keine Symbole für "${query}" gefunden (evtl. ist für diese Sprache kein Sprachserver aktiv, oder es gibt wirklich keine Treffer).`;
					}
					return symbols
						.slice(0, MAX_SYMBOL_RESULTS)
						.map((s) => {
							const relPath = vscode.workspace.asRelativePath(s.location.uri, false);
							const line = s.location.range.start.line + 1;
							return `${vscode.SymbolKind[s.kind]} "${s.name}" — ${relPath}:${line}`;
						})
						.join('\n');
				} catch (err) {
					return `Fehler bei der Symbolsuche: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
			describeCall: (input) => `🧭 Suche Symbol „${typeof input.query === 'string' ? input.query : '?'}“ …`,
			describeResult: (input, result) => {
				const q = typeof input.query === 'string' ? input.query : '?';
				return /^(Keine Symbole|Fehler)/.test(result)
					? `– keine Symbol-Treffer für „${q}“`
					: `✓ ${result.split('\n').length} Symbol-Treffer für „${q}“`;
			},
		}
		);
	}

	if (options.allowWrite) {
		tools.push({
			name: 'write_file',
			description:
				'Erstellt eine neue Datei ODER überschreibt eine bestehende Datei VOLLSTÄNDIG mit dem angegebenen Inhalt. Für gezielte Änderungen an einer bereits bestehenden Datei bevorzuge stattdessen replace_in_file – dort musst du nicht die ganze Datei abschreiben, was schneller und weniger fehleranfällig ist (kein Risiko, versehentlich Teile der Datei wegzulassen). Nutze write_file für neue Dateien oder wenn eine Datei wirklich komplett ersetzt werden soll.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relativer Dateipfad, z. B. "src/extension.ts".' },
					content: { type: 'string', description: 'Vollständiger neuer Inhalt der Datei.' },
				},
				required: ['path', 'content'],
			},
			invoke: async (input) => {
				const relPath = typeof input.path === 'string' ? input.path.trim() : '';
				const content = typeof input.content === 'string' ? input.content : undefined;
				if (!relPath || content === undefined) {
					return 'Fehler: "path" und "content" sind erforderlich.';
				}
				try {
					const absPath = resolveWorkspacePath(options.root, relPath);
					const absUri = vscode.Uri.file(absPath);
					let originalContent: string | null;
					try {
						const bytes = await vscode.workspace.fs.readFile(absUri);
						originalContent = Buffer.from(bytes).toString('utf8');
					} catch {
						originalContent = null;
					}
					await vscode.workspace.fs.writeFile(absUri, Buffer.from(content, 'utf8'));
					const cleanPath = relPath.replace(/^[/\\]+/, '');
					options.onWrite({ path: cleanPath, originalContent, newContent: content });
					return `OK: "${cleanPath}" geschrieben (${content.length} Zeichen).`;
				} catch (err) {
					return `Fehler beim Schreiben von "${relPath}": ${err instanceof Error ? err.message : String(err)}`;
				}
			},
			describeCall: (input) => `✏️ Schreibe Datei „${typeof input.path === 'string' ? input.path : '?'}“ …`,
			describeResult: (input, result) => {
				const p = typeof input.path === 'string' ? input.path : '?';
				return /^OK:/.test(result) ? `✓ „${p}“ geschrieben` : `✕ „${p}“ konnte nicht geschrieben werden`;
			},
		});

		tools.push({
			name: 'replace_in_file',
			description:
				'Ersetzt einen exakten, zusammenhängenden Textabschnitt in einer bestehenden Datei durch neuen Text, OHNE die ganze Datei neu schreiben zu müssen. Bevorzuge dies gegenüber write_file für Änderungen an bestehenden Dateien – du gibst nur die betroffene Stelle an, nicht die gesamte Datei. Der "search"-Text muss zeichengenau (inkl. Einrückung und Zeilenumbrüchen) aus dem aktuellen Dateiinhalt kopiert sein und darf in der Datei nur GENAU EINMAL vorkommen – sonst schlägt der Aufruf mit einer Fehlermeldung fehl (zu wenig oder zu viel Kontext im "search"-Text). Lies die Datei bei Bedarf vorher mit read_file, um den exakten aktuellen Inhalt zu kennen.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relativer Dateipfad, z. B. "src/extension.ts".' },
					search: {
						type: 'string',
						description:
							'Exakter, zusammenhängender Textabschnitt aus der aktuellen Datei, der ersetzt werden soll. Muss genau einmal in der Datei vorkommen.',
					},
					replace: { type: 'string', description: 'Der neue Text, der an dieser Stelle stehen soll.' },
				},
				required: ['path', 'search', 'replace'],
			},
			invoke: async (input) => {
				const relPath = typeof input.path === 'string' ? input.path.trim() : '';
				const search = typeof input.search === 'string' ? input.search : undefined;
				const replace = typeof input.replace === 'string' ? input.replace : undefined;
				if (!relPath || !search || replace === undefined) {
					return 'Fehler: "path" und "search" (nicht leer) sowie "replace" sind erforderlich.';
				}
				try {
					const absPath = resolveWorkspacePath(options.root, relPath);
					const absUri = vscode.Uri.file(absPath);
					let originalContent: string;
					try {
						const bytes = await vscode.workspace.fs.readFile(absUri);
						originalContent = Buffer.from(bytes).toString('utf8');
					} catch (err) {
						return `Datei "${relPath}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`;
					}
					const firstIndex = originalContent.indexOf(search);
					if (firstIndex === -1) {
						return `Fehler: Der angegebene "search"-Text wurde in "${relPath}" nicht gefunden (muss zeichengenau übereinstimmen, inkl. Einrückung/Zeilenumbrüche). Lies die Datei erneut, um den exakten aktuellen Inhalt zu prüfen.`;
					}
					const secondIndex = originalContent.indexOf(search, firstIndex + search.length);
					if (secondIndex !== -1) {
						return `Fehler: Der angegebene "search"-Text kommt in "${relPath}" mehrfach vor. Füge mehr umgebenden Kontext hinzu, damit die Stelle eindeutig ist.`;
					}
					const newContent = originalContent.slice(0, firstIndex) + replace + originalContent.slice(firstIndex + search.length);
					await vscode.workspace.fs.writeFile(absUri, Buffer.from(newContent, 'utf8'));
					const cleanPath = relPath.replace(/^[/\\]+/, '');
					options.onWrite({ path: cleanPath, originalContent, newContent });
					return `OK: "${cleanPath}" geändert (${search.length} → ${replace.length} Zeichen an einer Stelle).`;
				} catch (err) {
					return `Fehler beim Ändern von "${relPath}": ${err instanceof Error ? err.message : String(err)}`;
				}
			},
			describeCall: (input) => `✂️ Ändere Ausschnitt in „${typeof input.path === 'string' ? input.path : '?'}“ …`,
			describeResult: (input, result) => {
				const p = typeof input.path === 'string' ? input.path : '?';
				if (/^OK:/.test(result)) {
					return `✓ „${p}“ gezielt geändert`;
				}
				return /mehrfach vor/.test(result)
					? `✕ Stelle in „${p}“ nicht eindeutig`
					: /nicht gefunden/.test(result)
					? `✕ Stelle in „${p}“ nicht gefunden`
					: `✕ Änderung an „${p}“ fehlgeschlagen`;
			},
		});
	}

	if (options.helper) {
		const helper = options.helper;
		let delegateCallSeq = 0;
		tools.push({
			name: 'delegate_search',
			description:
				'Stellt eine gezielte Recherchefrage an ein günstigeres/schnelleres Hilfsmodell (z. B. "In welcher Datei ist die Button-Komponente definiert und wie heißt ihre CSS-Klasse?"), statt selbst viele Dateien einzeln zu durchsuchen. Das Hilfsmodell hat Lesezugriff auf den Workspace (list_files/read_file/search_files/find_symbol, aber keinen Schreibzugriff) und antwortet knapp in Prosa. Nutze dies für Recherche/Exploration, NICHT für das eigentliche Schreiben von Code – das bleibt deine Aufgabe.',
			inputSchema: {
				type: 'object',
				properties: {
					question: { type: 'string', description: 'Die konkrete Recherche-/Suchfrage an das Hilfsmodell.' },
				},
				required: ['question'],
			},
			invoke: async (input) => {
				const question = typeof input.question === 'string' ? input.question.trim() : '';
				if (!question) {
					return 'Fehler: Es wurde keine "question" angegeben.';
				}
				delegateCallSeq++;
				const seq = delegateCallSeq;
				const namespacedActivity: StageActivityCallback | undefined = helper.onActivity
					? (event: StageActivityEvent) =>
							helper.onActivity!(
								event.type === 'start'
									? { type: 'start', id: `delegate-${seq}-${event.id}`, label: `↳ ${event.label}` }
									: { type: 'end', id: `delegate-${seq}-${event.id}`, label: event.label, ok: event.ok }
							)
					: undefined;
				const subTools = createWorkspaceTools({ root: options.root, allowRead: true, allowWrite: false, onWrite: () => {} });
				try {
					const result = await sendPromptWithTools(
						helper.selector,
						`Du bist ein Rechercheassistent für einen Software-Entwickler-Agenten. Beantworte die folgende Frage knapp und konkret anhand des tatsächlichen Workspace-Inhalts (Dateipfade, Codestellen, Namen) – nutze die verfügbaren Tools, um nachzuschauen statt zu raten. Schreibe keinen Code, sondern fasse zusammen, was du gefunden hast.\n\nFrage:\n${question}`,
						subTools,
						helper.token,
						namespacedActivity,
						helper.onUsage
					);
					return result.text.trim() || '(Hilfsmodell hat keine Antwort geliefert.)';
				} catch (err) {
					return `Fehler beim Abfragen des Hilfsmodells: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
			describeCall: (input) => `🪄 Frage Hilfsmodell: „${typeof input.question === 'string' ? input.question : '?'}“ …`,
			describeResult: (_input, result) =>
				/^Fehler beim Abfragen/.test(result)
					? '✕ Hilfsmodell-Anfrage fehlgeschlagen'
					: `✓ Antwort vom Hilfsmodell erhalten (${result.length.toLocaleString('de-DE')} Zeichen)`,
		});

		// Only offered to stages that can write themselves — a research-only stage (Anforderungs-
		// analyse/Verifizierung) has no business spinning up agents that change files.
		if (options.allowWrite) {
			let subagentBatchSeq = 0;
			tools.push({
				name: 'run_subagents',
				description:
					'Startet bis zu 5 unabhängige Hilfs-Agenten GLEICHZEITIG (parallel), die jeweils eine eigene, in sich abgeschlossene Teilaufgabe im Workspace umsetzen (gleiches Werkzeug wie du: list_files/read_file/search_files/find_symbol/write_file/replace_in_file). Nutze dies NUR, wenn du dir wirklich sicher bist, dass sich die Aufgabe in 2 bis 5 voneinander UNABHÄNGIGE Teile zerlegen lässt (z. B. mehrere getrennte, sich nicht überschneidende Dateien) – bei Teilaufgaben, die sich gegenseitig beeinflussen oder dieselbe Datei anfassen, arbeite stattdessen selbst sequenziell weiter, sonst überschreiben sich die Agenten gegenseitig. Jeder Agent bekommt genau eine Teilaufgabe als eigenständigen Auftrag und antwortet mit einer kurzen Zusammenfassung, was er getan hat.',
				inputSchema: {
					type: 'object',
					properties: {
						tasks: {
							type: 'array',
							description:
								'2 bis 5 klar formulierte, voneinander unabhängige Teilaufgaben – je eine für einen eigenen parallelen Agenten.',
							items: { type: 'string' },
							minItems: 2,
							maxItems: 5,
						},
					},
					required: ['tasks'],
				},
				invoke: async (input) => {
					const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
					const tasks = rawTasks
						.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
						.map((t) => t.trim());
					if (tasks.length < 2) {
						return 'Fehler: "tasks" muss mindestens 2 unabhängige Teilaufgaben enthalten (sonst lohnt sich kein separater Agent — erledige es direkt selbst).';
					}
					const limited = tasks.slice(0, 5);
					subagentBatchSeq++;
					const batchSeq = subagentBatchSeq;
					const outcomes = await Promise.all(
						limited.map(async (task, i) => {
							const agentNo = i + 1;
							let namespacedActivity: StageActivityCallback | undefined;
							if (helper.onActivity) {
								namespacedActivity = (event: StageActivityEvent) => {
									const namespacedId = `subagent-${batchSeq}-${i}-${event.id}`;
									if (event.type === 'start') {
										helper.onActivity!({ type: 'start', id: namespacedId, label: `🧑‍💻 Agent ${agentNo}: ${event.label}` });
									} else {
										helper.onActivity!({ type: 'end', id: namespacedId, label: event.label, ok: event.ok });
									}
								};
							}
							const subTools = createWorkspaceTools({ root: options.root, allowRead: true, allowWrite: true, onWrite: options.onWrite });
							try {
								const result = await sendPromptWithTools(
									helper.selector,
									`Du bist einer von mehreren parallel arbeitenden Hilfs-Agenten innerhalb einer größeren Implementierungsaufgabe. Setze AUSSCHLIESSLICH die folgende, für dich vorgesehene Teilaufgabe um — sie ist bewusst so gewählt, dass sie unabhängig von den Teilaufgaben der anderen gerade parallel laufenden Agenten ist. Nutze write_file/replace_in_file, um Änderungen tatsächlich anzuwenden; eine Änderung nur zu beschreiben reicht nicht. Fasse am Ende knapp in Prosa zusammen, was du getan hast.\n\nDeine Teilaufgabe:\n${task}`,
									subTools,
									helper.token,
									namespacedActivity,
									helper.onUsage
								);
								return { task, ok: true, summary: result.text.trim() || '(keine Zusammenfassung geliefert)' };
							} catch (err) {
								return { task, ok: false, summary: `Fehler: ${err instanceof Error ? err.message : String(err)}` };
							}
						})
					);
					return outcomes
						.map((o, i) => `Agent ${i + 1} (Teilaufgabe: "${o.task}") – ${o.ok ? 'OK' : 'Fehler'}:\n${o.summary}`)
						.join('\n\n');
				},
				describeCall: (input) => {
					const n = Array.isArray(input.tasks) ? input.tasks.length : 0;
					return `🧑‍💻 Starte ${n} parallele Agenten …`;
				},
				describeResult: (_input, result) => `✓ Parallele Agenten abgeschlossen (${result.split('\n\n').length} Ergebnis(se))`,
			});
		}
	}

	return tools;
}
