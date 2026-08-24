(function () {
	const vscode = acquireVsCodeApi();

	const STATUS_LABELS = {
		pending: 'Ausstehend',
		active: 'Läuft …',
		waitingInput: 'Eingabe erforderlich',
		waitingApproval: 'Bestätigung erforderlich',
		completed: 'Abgeschlossen',
		skipped: 'Übersprungen',
		error: 'Fehler',
		aborted: 'Abgebrochen',
	};

	const STATUS_GLYPHS = {
		pending: '',
		active: '…',
		waitingInput: '!',
		waitingApproval: '!',
		completed: '✓',
		skipped: '–',
		error: '✕',
		aborted: '⏹',
	};

	const TYPE_LABELS = { ai: 'KI', gitPr: 'Git/PR', userApproval: 'Manuelles Gate' };

	const DEFAULT_EXPANDED_STATUSES = new Set(['active', 'waitingInput', 'waitingApproval', 'error', 'aborted']);

	let state = {
		phase: 'idle',
		ticketText: '',
		stages: [],
		fileChanges: [],
		busy: false,
		abortRequested: false,
		autoMode: false,
		debugMode: false,
		usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
	};
	const userExpanded = new Set();
	const userCollapsed = new Set();

	let historyEntries = [];
	let viewMode = 'pipeline';
	const expandedHistoryEntries = new Set();

	let pipelineDefinition = { stages: [] };
	let draftStages = [];
	let jsonEditMode = false;
	let saveStatus = null;
	let saveStatusTimer = null;

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message) {
			return;
		}
		if (message.type === 'state') {
			state = message.state;
			render();
		} else if (message.type === 'history') {
			historyEntries = message.entries || [];
			render();
		} else if (message.type === 'pipelineDefinition') {
			pipelineDefinition = message.definition || { stages: [] };
			if (!jsonEditMode) {
				draftStages = JSON.parse(JSON.stringify(pipelineDefinition.stages || []));
			}
			render();
		} else if (message.type === 'saveResult') {
			saveStatus = { ok: message.ok, droppedCount: message.droppedCount || 0, errorMessage: message.errorMessage };
			if (saveStatusTimer) {
				clearTimeout(saveStatusTimer);
			}
			saveStatusTimer = setTimeout(() => {
				saveStatus = null;
				render();
			}, 5000);
			render();
		}
	});

	vscode.postMessage({ type: 'ready' });

	function el(tag, attrs, ...children) {
		const node = document.createElement(tag);
		if (attrs) {
			for (const [key, value] of Object.entries(attrs)) {
				if (key === 'class') {
					node.className = value;
				} else {
					node.setAttribute(key, value);
				}
			}
		}
		for (const child of children) {
			if (child === null || child === undefined) {
				continue;
			}
			node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
		}
		return node;
	}

	function findStageDef(stageId) {
		return (pipelineDefinition.stages || []).find((s) => s.id === stageId);
	}

	function isExpanded(stage) {
		if (userCollapsed.has(stage.id)) {
			return false;
		}
		if (userExpanded.has(stage.id)) {
			return true;
		}
		return DEFAULT_EXPANDED_STATUSES.has(stage.status);
	}

	function toggleExpanded(stage) {
		if (isExpanded(stage)) {
			userCollapsed.add(stage.id);
			userExpanded.delete(stage.id);
		} else {
			userExpanded.add(stage.id);
			userCollapsed.delete(stage.id);
		}
		render();
	}

	function render() {
		const app = document.getElementById('app');
		app.innerHTML = '';
		app.appendChild(renderTopBar());
		if (viewMode === 'history') {
			app.appendChild(renderHistoryView());
		} else if (viewMode === 'stages') {
			app.appendChild(renderStagesView());
		} else if (!state || state.phase === 'idle') {
			app.appendChild(renderStartForm());
		} else {
			app.appendChild(renderPipeline());
		}
	}

	function renderTopBar() {
		const bar = el('div', { class: 'global-top-bar' });

		const titleRow = el('div', { class: 'global-title-row' });
		titleRow.appendChild(el('h1', {}, 'Thunderstorm'));

		const debugCheckbox = el('input', { type: 'checkbox' });
		debugCheckbox.checked = !!(state && state.debugMode);
		debugCheckbox.addEventListener('change', () => {
			vscode.postMessage({ type: 'setDebugMode', enabled: debugCheckbox.checked });
		});
		const debugLabel = el('label', { class: 'checkbox-label debug-toggle' }, debugCheckbox, ' Debug-Modus');
		titleRow.appendChild(debugLabel);

		const outputBtn = el('button', { class: 'link' }, 'Debug-Ausgabe');
		outputBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDebugOutput' }));
		titleRow.appendChild(outputBtn);

		bar.appendChild(titleRow);

		const tabs = el('div', { class: 'view-tabs' });
		const makeTab = (mode, label) => {
			const btn = el('button', { class: viewMode === mode ? 'tab-btn active' : 'tab-btn' }, label);
			btn.addEventListener('click', () => {
				viewMode = mode;
				render();
			});
			return btn;
		};
		tabs.appendChild(makeTab('pipeline', 'Pipeline'));
		tabs.appendChild(makeTab('history', `Verlauf${historyEntries.length ? ` (${historyEntries.length})` : ''}`));
		tabs.appendChild(makeTab('stages', `Stufen (${(pipelineDefinition.stages || []).length})`));
		bar.appendChild(tabs);

		return bar;
	}

	// ---------------------------------------------------------------- History

	function renderHistoryView() {
		const container = el('div');
		if (historyEntries.length === 0) {
			container.appendChild(
				el('p', {}, 'Noch keine Einträge. Der Verlauf füllt sich, sobald die Pipeline eine KI-Anfrage stellt.')
			);
			return container;
		}

		const total = sumUsage(historyEntries.map((e) => e.usage).filter(Boolean));
		if (total.requests > 0) {
			container.appendChild(
				el(
					'div',
					{
						class: 'usage-badge',
						title: 'Summe über alle Verlauf-Einträge (auch über mehrere Durchläufe hinweg, bis VS Code neu gestartet wird). Anfragen = echte Copilot-Anfragen, Tokens = grobe Schätzung.',
					},
					`Gesamt: ${formatUsageText(total)} (${historyEntries.length} Einträge)`
				)
			);
		}

		const list = el('div', { class: 'history-list' });
		const newestFirst = historyEntries.slice().reverse();
		for (const entry of newestFirst) {
			list.appendChild(renderHistoryEntry(entry));
		}
		container.appendChild(list);
		return container;
	}

	function renderHistoryEntry(entry) {
		const card = el('div', { class: 'history-entry' });

		const header = el('div', { class: 'history-entry-header' });
		header.appendChild(el('span', { class: 'history-entry-title' }, entry.title));
		header.appendChild(el('span', { class: 'history-entry-time' }, new Date(entry.timestamp).toLocaleTimeString()));
		card.appendChild(header);

		if (entry.configuredModel || entry.model) {
			const configured = entry.configuredModel ? `${entry.configuredModel.vendor}/${entry.configuredModel.family}` : '?';
			const actual = entry.model ? `${entry.model.vendor}/${entry.model.family} (${entry.model.name})` : '(kein Modell aufgelöst)';
			const mismatch = entry.model && entry.configuredModel && entry.model.family !== entry.configuredModel.family;
			const modelLine = el(
				'div',
				{ class: mismatch ? 'history-model-line history-model-mismatch' : 'history-model-line' },
				`Konfiguriert: ${configured} · Tatsächlich verwendet: ${actual}${mismatch ? ' ⚠ weicht ab!' : ''}`
			);
			card.appendChild(modelLine);
		}

		if (entry.usage && entry.usage.requests > 0) {
			card.appendChild(el('div', { class: 'history-model-line' }, formatUsageText(entry.usage)));
		}

		card.appendChild(el('div', { class: 'history-field-label' }, 'Eingabe'));
		card.appendChild(el('div', { class: 'history-field-value' }, entry.userInput));

		card.appendChild(el('div', { class: 'history-field-label' }, 'Ergebnis'));
		card.appendChild(el('div', { class: 'history-field-value' }, entry.result));

		if (entry.debug) {
			const expanded = expandedHistoryEntries.has(entry.id);
			const toggleBtn = el('button', { class: 'link' }, expanded ? 'Debug-Details ausblenden' : 'Debug-Details anzeigen');
			toggleBtn.addEventListener('click', () => {
				if (expanded) {
					expandedHistoryEntries.delete(entry.id);
				} else {
					expandedHistoryEntries.add(entry.id);
				}
				render();
			});
			card.appendChild(toggleBtn);

			if (expanded) {
				const box = el('div', { class: 'history-debug-box' });
				box.appendChild(el('div', { class: 'history-field-label' }, 'Prompt'));
				box.appendChild(el('pre', { class: 'history-pre' }, entry.debug.prompt));
				for (const call of entry.debug.toolCalls || []) {
					box.appendChild(
						el('div', { class: 'history-field-label' }, `Tool-Aufruf: ${call.name}(${JSON.stringify(call.input)})`)
					);
					box.appendChild(el('pre', { class: 'history-pre' }, call.result));
				}
				box.appendChild(el('div', { class: 'history-field-label' }, 'Rohantwort'));
				box.appendChild(el('pre', { class: 'history-pre' }, entry.debug.rawResponse));
				card.appendChild(box);
			}
		}

		return card;
	}

	// ------------------------------------------------------------- Start form

	function renderStartForm() {
		const container = el('div');
		container.appendChild(
			el(
				'p',
				{},
				'Beschreiben Sie das umzusetzende Ticket. Thunderstorm arbeitet die konfigurierte Stufenkette ab (siehe Tab „Stufen") und bereitet am Ende einen Pull Request vor.'
			)
		);
		container.appendChild(el('label', { class: 'field-label' }, 'Ticket-Beschreibung'));
		const textarea = el('textarea', {
			id: 'ticket-input',
			placeholder: 'z. B. "Füge einen Umschalter für den Dark Mode auf der Einstellungsseite hinzu ..."',
		});

		const autoModeCheckbox = el('input', { type: 'checkbox', id: 'auto-mode-checkbox' });
		const autoModeLabel = el(
			'label',
			{ class: 'checkbox-label' },
			autoModeCheckbox,
			' Auto-Modus: Bestätigungs-Gates automatisch durchlaufen, ohne nach jeder Stufe nachzufragen'
		);

		const startBtn = el('button', {}, 'Pipeline starten');
		startBtn.disabled = !!state.busy;
		startBtn.addEventListener('click', () => {
			const text = textarea.value.trim();
			if (!text) {
				return;
			}
			vscode.postMessage({ type: 'start', text, autoMode: autoModeCheckbox.checked });
		});
		container.appendChild(textarea);
		container.appendChild(el('div', { class: 'actions' }, autoModeLabel));
		container.appendChild(el('div', { class: 'actions' }, startBtn));
		return container;
	}

	// ----------------------------------------------------------- Pipeline run

	function formatCount(n) {
		return (n || 0).toLocaleString('de-DE');
	}

	function formatUsageText(usage) {
		const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
		return `${formatCount(usage.requests)} Anfrage${usage.requests === 1 ? '' : 'n'} · ~${formatCount(totalTokens)} Tokens geschätzt`;
	}

	function sumUsage(list) {
		return list.reduce(
			(acc, u) => ({
				requests: acc.requests + (u.requests || 0),
				inputTokens: acc.inputTokens + (u.inputTokens || 0),
				outputTokens: acc.outputTokens + (u.outputTokens || 0),
			}),
			{ requests: 0, inputTokens: 0, outputTokens: 0 }
		);
	}

	function renderUsageBadge(usage) {
		const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
		const text =
			`${formatCount(usage.requests)} KI-Anfrage${usage.requests === 1 ? '' : 'n'} bisher · ` +
			`~${formatCount(totalTokens)} Tokens geschätzt (${formatCount(usage.inputTokens)} ein / ${formatCount(usage.outputTokens)} aus)`;
		return el(
			'div',
			{
				class: 'usage-badge',
				title: 'Anfragen = echte Copilot-Anfragen. Tokens = grobe Schätzung, keine offizielle Abrechnungsgröße.',
			},
			text
		);
	}

	function renderPipeline() {
		const container = el('div');

		const topBar = el('div', { class: 'top-bar' });
		const resetBtn = el('button', { class: 'secondary' }, 'Zurücksetzen');
		resetBtn.addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
		topBar.appendChild(resetBtn);
		container.appendChild(topBar);

		container.appendChild(el('div', { class: 'ticket-preview' }, state.ticketText));

		if (state.usage && state.usage.requests > 0) {
			container.appendChild(renderUsageBadge(state.usage));
		}

		if (state.autoMode && state.phase === 'running') {
			container.appendChild(
				el('div', { class: 'auto-mode-badge' }, 'Auto-Modus aktiv: Bestätigungs-Gates laufen ohne Rückfrage durch.')
			);
		}

		if (state.phase === 'running') {
			container.appendChild(renderAbortControls());
		}

		const stepper = el('ul', { class: 'stepper' });
		for (const stage of state.stages) {
			stepper.appendChild(renderStage(stage));
		}
		container.appendChild(stepper);

		if (state.phase === 'done' && state.stages.length && state.stages[state.stages.length - 1].status === 'completed') {
			container.appendChild(
				el('div', { class: 'done-banner' }, 'Vorgang abgeschlossen. Sie können jederzeit einen neuen Vorgang starten.')
			);
		}

		if (state.phase === 'aborted') {
			container.appendChild(
				el('div', { class: 'aborted-banner' }, 'Vorgang abgebrochen. Sie können jederzeit einen neuen Vorgang starten.')
			);
		}

		return container;
	}

	function renderAbortControls() {
		const wrap = el('div', { class: 'abort-bar' });
		if (state.abortRequested) {
			wrap.appendChild(
				el('span', { class: 'abort-note' }, 'Abbruch nach aktuellem Schritt vorgemerkt – die nächste Stufe startet nicht mehr.')
			);
			const undoBtn = el('button', { class: 'secondary' }, 'Abbruch zurücknehmen');
			undoBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancelAbortRequest' }));
			wrap.appendChild(undoBtn);
		} else {
			const afterStepBtn = el('button', { class: 'secondary' }, 'Nach aktueller Stufe abbrechen');
			afterStepBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestAbortAfterCurrentStep' }));
			const nowBtn = el('button', { class: 'danger' }, 'Sofort abbrechen');
			nowBtn.addEventListener('click', () => vscode.postMessage({ type: 'abortNow' }));
			wrap.appendChild(afterStepBtn);
			wrap.appendChild(nowBtn);
		}
		return wrap;
	}

	function renderStage(stage) {
		const li = el('li', { class: 'step' });
		li.dataset.status = stage.status;

		const header = el('div', { class: 'step-header' });
		header.appendChild(el('span', { class: 'step-marker' }, STATUS_GLYPHS[stage.status] || ''));
		header.appendChild(el('span', { class: 'step-title' }, stage.name));
		header.appendChild(el('span', { class: 'step-type-badge' }, TYPE_LABELS[stage.type] || stage.type));
		header.appendChild(el('span', { class: 'step-status-label' }, STATUS_LABELS[stage.status] || stage.status));
		header.addEventListener('click', () => toggleExpanded(stage));
		li.appendChild(header);

		const expanded = isExpanded(stage);
		const body = el('div', { class: expanded ? 'step-body' : 'step-body collapsed' });
		body.appendChild(renderStageBody(stage));
		li.appendChild(body);

		return li;
	}

	function renderStageBody(stage) {
		const frag = el('div');

		if (stage.error) {
			frag.appendChild(el('div', { class: 'error-box' }, stage.error));
			const errorActions = [];
			if (state.fileChanges && state.fileChanges.length) {
				const diffBtn = el('button', { class: 'secondary' }, 'Diff anzeigen');
				diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }));
				errorActions.push(diffBtn);
			}
			const retryBtn = el('button', {}, 'Erneut versuchen');
			retryBtn.disabled = !!state.busy;
			retryBtn.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
			errorActions.push(retryBtn);
			frag.appendChild(el('div', { class: 'actions' }, ...errorActions));
			return frag;
		}

		if (stage.detail) {
			frag.appendChild(el('div', { class: 'detail-text' }, stage.detail));
		}

		if (stage.items && stage.items.length) {
			const list = el('ul', { class: 'item-list' });
			for (const item of stage.items) {
				list.appendChild(el('li', {}, item));
			}
			frag.appendChild(list);
		}

		if (stage.status === 'active') {
			frag.appendChild(el('div', { class: 'busy-indicator' }, 'Wird verarbeitet …'));
		}

		if (stage.usage && stage.usage.requests > 0) {
			frag.appendChild(
				el(
					'div',
					{
						class: 'stage-usage-line',
						title: 'Anfragen = echte Copilot-Anfragen. Tokens = grobe Schätzung, keine offizielle Abrechnungsgröße.',
					},
					formatUsageText(stage.usage)
				)
			);
		}

		if (stage.type === 'ai') {
			frag.appendChild(renderAiStageControls(stage));
		} else if (stage.type === 'gitPr') {
			frag.appendChild(renderGitPrControls());
		} else if (stage.type === 'userApproval') {
			frag.appendChild(renderUserApprovalControls(stage));
		}

		return frag;
	}

	function renderAiStageControls(stage) {
		const wrap = el('div');
		const hasChanges = state.fileChanges && state.fileChanges.length > 0;

		if (stage.status === 'waitingApproval') {
			const actionsRow = [];
			if (hasChanges) {
				const diffBtn = el('button', { class: 'secondary' }, 'Diff anzeigen');
				diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }));
				actionsRow.push(diffBtn);
			}
			const continueBtn = el('button', {}, 'Weiter');
			continueBtn.disabled = !!state.busy;
			continueBtn.addEventListener('click', () => vscode.postMessage({ type: 'approveStage', stageId: stage.id }));
			actionsRow.push(continueBtn);
			wrap.appendChild(el('div', { class: 'actions' }, ...actionsRow));

			wrap.appendChild(el('label', { class: 'field-label' }, 'Änderungen anfordern (optional)'));
			const textarea = el('textarea', { placeholder: 'Was soll an dieser Stufe anders gemacht werden?' });
			const requestBtn = el('button', { class: 'secondary' }, 'Änderungen anfordern');
			requestBtn.disabled = !!state.busy;
			requestBtn.addEventListener('click', () => {
				const text = textarea.value.trim();
				if (!text) {
					return;
				}
				vscode.postMessage({ type: 'requestStageChanges', stageId: stage.id, text });
			});
			wrap.appendChild(textarea);
			wrap.appendChild(el('div', { class: 'actions' }, requestBtn));
		} else if (stage.status === 'waitingInput') {
			const def = findStageDef(stage.id);
			const isRetryGate = !!(def && def.gate && def.gate.onFail && def.gate.onFail.action === 'retryStage');

			if (isRetryGate) {
				const targetName = (findStageDef(def.gate.onFail.targetStageId) || {}).name || def.gate.onFail.targetStageId;
				const retryBtn = el('button', {}, `Erneut versuchen (über „${targetName}“)`);
				retryBtn.disabled = !!state.busy;
				retryBtn.addEventListener('click', () => vscode.postMessage({ type: 'retryGateTarget', stageId: stage.id }));
				const forceBtn = el('button', { class: 'secondary' }, 'Trotzdem fortfahren');
				forceBtn.disabled = !!state.busy;
				forceBtn.addEventListener('click', () => vscode.postMessage({ type: 'forceGateContinue', stageId: stage.id }));
				wrap.appendChild(el('div', { class: 'actions' }, retryBtn, forceBtn));
			} else {
				const autonomyBtn = el('button', { class: 'secondary button-outline' }, 'Entwickler soll selbst entscheiden');
				autonomyBtn.disabled = !!state.busy;
				autonomyBtn.title = 'Überspringt die Rückfrage. Die nächste Stufe bekommt Ticket-Text und alle bisher gegebenen Informationen wie gewohnt, plus den Hinweis, offene Punkte selbst zu entscheiden.';
				autonomyBtn.addEventListener('click', () => vscode.postMessage({ type: 'proceedAutonomously', stageId: stage.id }));
				wrap.appendChild(el('div', { class: 'actions' }, autonomyBtn));

				wrap.appendChild(el('label', { class: 'field-label' }, 'Oder: Fehlende Informationen ergänzen'));
				const textarea = el('textarea', { placeholder: 'Zusätzliche Details für die KI ...' });
				const btn = el('button', {}, 'Erneut prüfen');
				btn.disabled = !!state.busy;
				btn.addEventListener('click', () => {
					const text = textarea.value.trim();
					if (!text) {
						return;
					}
					vscode.postMessage({ type: 'submitAdditionalInfo', stageId: stage.id, text });
				});
				wrap.appendChild(textarea);
				wrap.appendChild(el('div', { class: 'actions' }, btn));
			}
		}
		return wrap;
	}

	function renderGitPrControls() {
		const wrap = el('div');
		if (state.prUrl) {
			const btn = el('button', {}, 'Pull Request öffnen');
			btn.addEventListener('click', () => vscode.postMessage({ type: 'openPr', text: state.prUrl }));
			wrap.appendChild(el('div', { class: 'actions' }, btn));
		}
		return wrap;
	}

	function renderUserApprovalControls(stage) {
		const wrap = el('div');
		if (state.fileChanges && state.fileChanges.length) {
			const diffBtn = el('button', { class: 'secondary' }, 'Diff anzeigen');
			diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }));
			wrap.appendChild(el('div', { class: 'actions' }, diffBtn));
		}
		if (stage.status === 'waitingApproval') {
			const btn = el('button', {}, 'Freigeben');
			btn.addEventListener('click', () => vscode.postMessage({ type: 'completeUserApproval', stageId: stage.id }));
			wrap.appendChild(el('div', { class: 'actions' }, btn));
		}
		return wrap;
	}

	// ------------------------------------------------------------ Stages editor

	function saveDraftStages() {
		vscode.postMessage({ type: 'savePipelineDefinition', stages: draftStages });
	}

	function generateStageId(prefix) {
		let candidate = `${prefix}-${Date.now().toString(36)}`;
		let n = 1;
		while (draftStages.some((s) => s.id === candidate)) {
			candidate = `${prefix}-${Date.now().toString(36)}-${n++}`;
		}
		return candidate;
	}

	function formatStageSummary(stage) {
		if (stage.type === 'ai') {
			const parts = [`${stage.modelVendor || '?'}/${stage.modelFamily || '?'}`];
			parts.push(stage.tools && stage.tools !== 'none' ? `Dateizugriff: ${stage.tools}` : 'kein Dateizugriff');
			if (stage.gate) {
				parts.push(
					stage.gate.onFail && stage.gate.onFail.action === 'retryStage'
						? `Gate → Retry „${stage.gate.onFail.targetStageId}“ (max ${stage.gate.onFail.maxAutoRetries})`
						: 'Gate → Pause bei Fehlschlag'
				);
			}
			parts.push(stage.requireApproval === false ? 'kein Bestätigungs-Gate' : 'mit Bestätigungs-Gate');
			return parts.join(' · ');
		}
		if (stage.type === 'gitPr') {
			return `Ziel-Branch „${stage.baseBranch}“ · Präfix „${stage.branchPrefix}“ · PR ${
				stage.autoCreatePullRequest === false ? 'deaktiviert' : 'automatisch'
			}`;
		}
		if (stage.type === 'userApproval') {
			return stage.instructions || '(keine Hinweise hinterlegt)';
		}
		return '';
	}

	function renderStagesView() {
		const container = el('div');
		container.appendChild(
			el(
				'p',
				{},
				'Die Stufenkette, die bei jedem Lauf abgearbeitet wird. Strukturelle Änderungen (Reihenfolge, Duplizieren, Löschen, Hinzufügen) werden sofort gespeichert; Details bearbeiten Sie über „Als JSON bearbeiten". Änderungen wirken sich erst auf den nächsten Start aus.'
			)
		);

		if (saveStatus) {
			let text;
			let cls;
			if (saveStatus.errorMessage) {
				text = `✕ Speichern fehlgeschlagen: ${saveStatus.errorMessage}`;
				cls = 'save-status save-status-error';
			} else if (saveStatus.droppedCount > 0) {
				text = `⚠ Gespeichert, aber ${saveStatus.droppedCount} Stufe(n) waren ungültig und wurden verworfen.`;
				cls = 'save-status save-status-warning';
			} else {
				text = '✓ Gespeichert.';
				cls = 'save-status save-status-ok';
			}
			container.appendChild(el('div', { class: cls }, text));
		}

		if (jsonEditMode) {
			container.appendChild(renderJsonEditor());
			return container;
		}

		const editJsonBtn = el('button', { class: 'secondary' }, 'Als JSON bearbeiten');
		editJsonBtn.addEventListener('click', () => {
			jsonEditMode = true;
			render();
		});
		container.appendChild(el('div', { class: 'actions' }, editJsonBtn));

		const list = el('div', { class: 'stage-list' });
		draftStages.forEach((stage, index) => {
			list.appendChild(renderStageCard(stage, index));
		});
		container.appendChild(list);

		const addRow = el('div', { class: 'actions' });
		const addAi = el('button', { class: 'secondary' }, '+ KI-Stufe');
		addAi.addEventListener('click', () => {
			draftStages = draftStages.concat([
				{
					id: generateStageId('ai'),
					type: 'ai',
					name: 'Neue KI-Stufe',
					modelVendor: 'copilot',
					modelFamily: 'gpt-4o',
					tools: 'none',
					includeWorkspaceContext: false,
					requireApproval: true,
					prompt: '{{ticket}}\n\nBisheriger Kontext:\n{{context}}\n\n{{additionalInfo}}',
				},
			]);
			saveDraftStages();
		});
		const addGit = el('button', { class: 'secondary' }, '+ Git/PR-Stufe');
		addGit.addEventListener('click', () => {
			draftStages = draftStages.concat([
				{
					id: generateStageId('gitpr'),
					type: 'gitPr',
					name: 'Neue Git/PR-Stufe',
					baseBranch: 'main',
					branchPrefix: 'thunderstorm/',
					autoCreatePullRequest: true,
				},
			]);
			saveDraftStages();
		});
		const addApproval = el('button', { class: 'secondary' }, '+ Manuelles Gate');
		addApproval.addEventListener('click', () => {
			draftStages = draftStages.concat([
				{
					id: generateStageId('approval'),
					type: 'userApproval',
					name: 'Neues manuelles Gate',
					instructions: 'Bitte prüfen und freigeben.',
				},
			]);
			saveDraftStages();
		});
		addRow.appendChild(addAi);
		addRow.appendChild(addGit);
		addRow.appendChild(addApproval);
		container.appendChild(addRow);

		return container;
	}

	function renderStageCard(stage, index) {
		const card = el('div', { class: 'stage-card' });
		const header = el('div', { class: 'stage-card-header' });
		header.appendChild(el('span', { class: 'stage-card-index' }, `${index + 1}.`));
		header.appendChild(el('span', { class: 'stage-card-name' }, stage.name));
		header.appendChild(el('span', { class: 'stage-card-type' }, TYPE_LABELS[stage.type] || stage.type));
		card.appendChild(header);

		card.appendChild(el('div', { class: 'stage-card-summary' }, formatStageSummary(stage)));
		card.appendChild(el('div', { class: 'stage-card-id' }, `id: ${stage.id}`));

		const actions = el('div', { class: 'actions' });
		const upBtn = el('button', { class: 'secondary' }, '↑');
		upBtn.disabled = index === 0;
		upBtn.addEventListener('click', () => {
			const copy = draftStages.slice();
			[copy[index - 1], copy[index]] = [copy[index], copy[index - 1]];
			draftStages = copy;
			saveDraftStages();
		});
		const downBtn = el('button', { class: 'secondary' }, '↓');
		downBtn.disabled = index === draftStages.length - 1;
		downBtn.addEventListener('click', () => {
			const copy = draftStages.slice();
			[copy[index + 1], copy[index]] = [copy[index], copy[index + 1]];
			draftStages = copy;
			saveDraftStages();
		});
		const dupBtn = el('button', { class: 'secondary' }, 'Duplizieren');
		dupBtn.addEventListener('click', () => {
			const clone = JSON.parse(JSON.stringify(stage));
			clone.id = generateStageId(stage.id);
			clone.name = `${stage.name} (Kopie)`;
			const copy = draftStages.slice();
			copy.splice(index + 1, 0, clone);
			draftStages = copy;
			saveDraftStages();
		});
		const delBtn = el('button', { class: 'danger' }, 'Löschen');
		delBtn.addEventListener('click', () => {
			if (!confirm(`Stufe „${stage.name}" wirklich löschen?`)) {
				return;
			}
			draftStages = draftStages.filter((_, i) => i !== index);
			saveDraftStages();
		});
		actions.appendChild(upBtn);
		actions.appendChild(downBtn);
		actions.appendChild(dupBtn);
		actions.appendChild(delBtn);
		card.appendChild(actions);

		return card;
	}

	function renderJsonEditor() {
		const wrap = el('div');
		const textarea = el('textarea', { class: 'json-editor' }, JSON.stringify(draftStages, null, 2));
		const errorBox = el('div', { class: 'error-box json-editor-error collapsed' });

		const saveBtn = el('button', {}, 'Speichern');
		saveBtn.addEventListener('click', () => {
			let parsed;
			try {
				parsed = JSON.parse(textarea.value);
			} catch (err) {
				errorBox.textContent = `Ungültiges JSON: ${err.message}`;
				errorBox.className = 'error-box';
				return;
			}
			if (!Array.isArray(parsed)) {
				errorBox.textContent = 'Die oberste Ebene muss ein Array von Stufen sein.';
				errorBox.className = 'error-box';
				return;
			}
			draftStages = parsed;
			jsonEditMode = false;
			saveDraftStages();
		});
		const cancelBtn = el('button', { class: 'secondary' }, 'Abbrechen');
		cancelBtn.addEventListener('click', () => {
			jsonEditMode = false;
			render();
		});

		wrap.appendChild(textarea);
		wrap.appendChild(errorBox);
		wrap.appendChild(el('div', { class: 'actions' }, saveBtn, cancelBtn));
		return wrap;
	}

	render();
})();
