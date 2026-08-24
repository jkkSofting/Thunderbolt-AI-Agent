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
	};

	const STATUS_GLYPHS = {
		pending: '',
		active: '…',
		waitingInput: '!',
		waitingApproval: '!',
		completed: '✓',
		skipped: '–',
		error: '✕',
	};

	const DEFAULT_EXPANDED_STATUSES = new Set(['active', 'waitingInput', 'waitingApproval', 'error']);

	let state = { phase: 'idle', ticketText: '', steps: {}, fileChanges: [], busy: false };
	const userExpanded = new Set();
	const userCollapsed = new Set();

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message && message.type === 'state') {
			state = message.state;
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
		if (!state || state.phase === 'idle') {
			app.appendChild(renderStartForm());
		} else {
			app.appendChild(renderPipeline());
		}
	}

	function renderStartForm() {
		const container = el('div');
		container.appendChild(el('h1', {}, 'Thunderstorm'));
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
		const startBtn = el('button', {}, 'Pipeline starten');
		startBtn.disabled = !!state.busy;
		startBtn.addEventListener('click', () => {
			const text = textarea.value.trim();
			if (!text) {
				return;
			}
			vscode.postMessage({ type: 'start', text });
		});
		container.appendChild(textarea);
		container.appendChild(el('div', { class: 'actions' }, startBtn));
		return container;
	}

	function renderPipeline() {
		const container = el('div');

		const topBar = el('div', { class: 'top-bar' });
		topBar.appendChild(el('h1', {}, 'Thunderstorm'));
		const resetBtn = el('button', { class: 'secondary' }, 'Zurücksetzen');
		resetBtn.addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
		topBar.appendChild(resetBtn);
		container.appendChild(topBar);

		container.appendChild(el('div', { class: 'ticket-preview' }, state.ticketText));

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

		return container;
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
