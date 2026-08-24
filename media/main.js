(function () {
	const vscode = acquireVsCodeApi();

	const STEP_ORDER = ['requirements', 'implementation', 'verification', 'pullRequest', 'userVerification'];

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

	const DEFAULT_EXPANDED_STATUSES = new Set(['active', 'waitingInput', 'waitingApproval', 'error', 'aborted']);

	let state = {
		phase: 'idle',
		ticketText: '',
		steps: {},
		fileChanges: [],
		busy: false,
		abortRequested: false,
		autoMode: false,
		debugMode: false,
	};
	const userExpanded = new Set();
	const userCollapsed = new Set();

	let historyEntries = [];
	let viewMode = 'pipeline';
	const expandedHistoryEntries = new Set();

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

	function isExpanded(step) {
		if (userCollapsed.has(step.id)) {
			return false;
		}
		if (userExpanded.has(step.id)) {
			return true;
		}
		return DEFAULT_EXPANDED_STATUSES.has(step.status);
	}

	function toggleExpanded(step) {
		if (isExpanded(step)) {
			userCollapsed.add(step.id);
			userExpanded.delete(step.id);
		} else {
			userExpanded.add(step.id);
			userCollapsed.delete(step.id);
		}
		render();
	}

	function render() {
		const app = document.getElementById('app');
		app.innerHTML = '';
		app.appendChild(renderTopBar());
		if (viewMode === 'history') {
			app.appendChild(renderHistoryView());
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
		const pipelineTab = el('button', { class: viewMode === 'pipeline' ? 'tab-btn active' : 'tab-btn' }, 'Pipeline');
		pipelineTab.addEventListener('click', () => {
			viewMode = 'pipeline';
			render();
		});
		const historyLabel = `Verlauf${historyEntries.length ? ` (${historyEntries.length})` : ''}`;
		const historyTab = el('button', { class: viewMode === 'history' ? 'tab-btn active' : 'tab-btn' }, historyLabel);
		historyTab.addEventListener('click', () => {
			viewMode = 'history';
			render();
		});
		tabs.appendChild(pipelineTab);
		tabs.appendChild(historyTab);
		bar.appendChild(tabs);

		return bar;
	}

	function renderHistoryView() {
		const container = el('div');
		if (historyEntries.length === 0) {
			container.appendChild(
				el('p', {}, 'Noch keine Einträge. Der Verlauf füllt sich, sobald die Pipeline eine KI-Anfrage stellt.')
			);
			return container;
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
				box.appendChild(
					el(
						'div',
						{ class: 'history-field-label' },
						`Modell: ${entry.debug.model.vendor}/${entry.debug.model.family} (${entry.debug.model.name})`
					)
				);
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

	function renderStartForm() {
		const container = el('div');
		container.appendChild(
			el(
				'p',
				{},
				'Beschreiben Sie das umzusetzende Ticket. Thunderstorm prüft die Anforderung, implementiert die Änderungen, verifiziert sie gegen das Ticket und bereitet einen Pull Request vor.'
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
			' Auto-Modus: Implementierung und Verifizierung automatisch durchlaufen, ohne nach jedem Schritt nachzufragen'
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

	function renderPipeline() {
		const container = el('div');

		const topBar = el('div', { class: 'top-bar' });
		const resetBtn = el('button', { class: 'secondary' }, 'Zurücksetzen');
		resetBtn.addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
		topBar.appendChild(resetBtn);
		container.appendChild(topBar);

		container.appendChild(el('div', { class: 'ticket-preview' }, state.ticketText));

		if (state.autoMode && state.phase === 'running') {
			container.appendChild(
				el(
					'div',
					{ class: 'auto-mode-badge' },
					'Auto-Modus aktiv: Implementierung und Verifizierung laufen ohne Rückfrage durch.'
				)
			);
		}

		if (state.phase === 'running') {
			container.appendChild(renderAbortControls());
		}

		const stepper = el('ul', { class: 'stepper' });
		for (const id of STEP_ORDER) {
			const step = state.steps[id];
			if (step) {
				stepper.appendChild(renderStep(step));
			}
		}
		container.appendChild(stepper);

		if (state.phase === 'done' && state.steps.userVerification && state.steps.userVerification.status === 'completed') {
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
				el('span', { class: 'abort-note' }, 'Abbruch nach aktuellem Schritt vorgemerkt – der nächste Schritt startet nicht mehr.')
			);
			const undoBtn = el('button', { class: 'secondary' }, 'Abbruch zurücknehmen');
			undoBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancelAbortRequest' }));
			wrap.appendChild(undoBtn);
		} else {
			const afterStepBtn = el('button', { class: 'secondary' }, 'Nach aktuellem Schritt abbrechen');
			afterStepBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestAbortAfterCurrentStep' }));
			const nowBtn = el('button', { class: 'danger' }, 'Sofort abbrechen');
			nowBtn.addEventListener('click', () => vscode.postMessage({ type: 'abortNow' }));
			wrap.appendChild(afterStepBtn);
			wrap.appendChild(nowBtn);
		}
		return wrap;
	}

	function renderStep(step) {
		const li = el('li', { class: 'step' });
		li.dataset.status = step.status;

		const header = el('div', { class: 'step-header' });
		header.appendChild(el('span', { class: 'step-marker' }, STATUS_GLYPHS[step.status] || ''));
		header.appendChild(el('span', { class: 'step-title' }, step.title));
		header.appendChild(el('span', { class: 'step-status-label' }, STATUS_LABELS[step.status] || step.status));
		header.addEventListener('click', () => toggleExpanded(step));
		li.appendChild(header);

		const expanded = isExpanded(step);
		const body = el('div', { class: expanded ? 'step-body' : 'step-body collapsed' });
		body.appendChild(renderStepBody(step));
		li.appendChild(body);

		return li;
	}

	function renderStepBody(step) {
		const frag = el('div');

		if (step.error) {
			frag.appendChild(el('div', { class: 'error-box' }, step.error));
			const retryBtn = el('button', {}, 'Erneut versuchen');
			retryBtn.disabled = !!state.busy;
			retryBtn.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
			frag.appendChild(el('div', { class: 'actions' }, retryBtn));
			return frag;
		}

		if (step.detail) {
			frag.appendChild(el('div', { class: 'detail-text' }, step.detail));
		}

		if (step.items && step.items.length) {
			const list = el('ul', { class: 'item-list' });
			for (const item of step.items) {
				list.appendChild(el('li', {}, item));
			}
			frag.appendChild(list);
		}

		if (step.status === 'active') {
			frag.appendChild(el('div', { class: 'busy-indicator' }, 'Wird verarbeitet …'));
		}

		switch (step.id) {
			case 'requirements':
				frag.appendChild(renderRequirementsControls(step));
				break;
			case 'implementation':
				frag.appendChild(renderImplementationControls(step));
				break;
			case 'verification':
				frag.appendChild(renderVerificationControls(step));
				break;
			case 'pullRequest':
				frag.appendChild(renderPullRequestControls());
				break;
			case 'userVerification':
				frag.appendChild(renderUserVerificationControls(step));
				break;
		}

		return frag;
	}

	function renderRequirementsControls(step) {
		const wrap = el('div');
		if (step.status === 'waitingApproval') {
			const btn = el('button', {}, 'Weiter zur Implementierung');
			btn.disabled = !!state.busy;
			btn.addEventListener('click', () => vscode.postMessage({ type: 'approveRequirements' }));
			wrap.appendChild(el('div', { class: 'actions' }, btn));
		} else if (step.status === 'waitingInput') {
			wrap.appendChild(el('label', { class: 'field-label' }, 'Fehlende Informationen ergänzen'));
			const textarea = el('textarea', { placeholder: 'Zusätzliche Details für die KI ...' });
			const btn = el('button', {}, 'Erneut prüfen');
			btn.disabled = !!state.busy;
			btn.addEventListener('click', () => {
				const text = textarea.value.trim();
				if (!text) {
					return;
				}
				vscode.postMessage({ type: 'provideInfo', text });
			});
			wrap.appendChild(textarea);
			wrap.appendChild(el('div', { class: 'actions' }, btn));
		}
		return wrap;
	}

	function renderImplementationControls(step) {
		const wrap = el('div');
		if (step.status === 'waitingApproval') {
			const diffBtn = el('button', { class: 'secondary' }, 'Diff anzeigen');
			diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }));
			const continueBtn = el('button', {}, 'Weiter zur Verifizierung');
			continueBtn.disabled = !!state.busy;
			continueBtn.addEventListener('click', () => vscode.postMessage({ type: 'approveImplementation' }));
			wrap.appendChild(el('div', { class: 'actions' }, diffBtn, continueBtn));

			wrap.appendChild(el('label', { class: 'field-label' }, 'Änderungen anfordern (optional)'));
			const textarea = el('textarea', { placeholder: 'Was soll an der Umsetzung geändert werden?' });
			const requestBtn = el('button', { class: 'secondary' }, 'Änderungen anfordern');
			requestBtn.disabled = !!state.busy;
			requestBtn.addEventListener('click', () => {
				const text = textarea.value.trim();
				if (!text) {
					return;
				}
				vscode.postMessage({ type: 'requestImplementationChanges', text });
			});
			wrap.appendChild(textarea);
			wrap.appendChild(el('div', { class: 'actions' }, requestBtn));
		}
		return wrap;
	}

	function renderVerificationControls(step) {
		const wrap = el('div');
		if (step.status === 'waitingApproval') {
			const diffBtn = el('button', { class: 'secondary' }, 'Diff anzeigen');
			diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }));
			const btn = el('button', {}, 'Pull Request erstellen');
			btn.disabled = !!state.busy;
			btn.addEventListener('click', () => vscode.postMessage({ type: 'approveForPullRequest' }));
			wrap.appendChild(el('div', { class: 'actions' }, diffBtn, btn));
		} else if (step.status === 'waitingInput') {
			const reBtn = el('button', {}, 'Erneut implementieren');
			reBtn.disabled = !!state.busy;
			reBtn.addEventListener('click', () => vscode.postMessage({ type: 'reimplementAfterVerification' }));
			const forceBtn = el('button', { class: 'secondary' }, 'Trotzdem fortfahren');
			forceBtn.disabled = !!state.busy;
			forceBtn.addEventListener('click', () => vscode.postMessage({ type: 'forceProceedToPullRequest' }));
			wrap.appendChild(el('div', { class: 'actions' }, reBtn, forceBtn));
		}
		return wrap;
	}

	function renderPullRequestControls() {
		const wrap = el('div');
		if (state.prUrl) {
			const btn = el('button', {}, 'Pull Request öffnen');
			btn.addEventListener('click', () => vscode.postMessage({ type: 'openPr', text: state.prUrl }));
			wrap.appendChild(el('div', { class: 'actions' }, btn));
		}
		return wrap;
	}

	function renderUserVerificationControls(step) {
		const wrap = el('div');
		if (state.fileChanges && state.fileChanges.length) {
			const diffBtn = el('button', { class: 'secondary' }, 'Diff anzeigen');
			diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }));
			wrap.appendChild(el('div', { class: 'actions' }, diffBtn));
		}
		if (step.status === 'waitingApproval') {
			const btn = el('button', {}, 'Freigeben');
			btn.addEventListener('click', () => vscode.postMessage({ type: 'completeUserVerification' }));
			wrap.appendChild(el('div', { class: 'actions' }, btn));
		}
		return wrap;
	}

	render();
})();
