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
		active: '',
		waitingInput: '!',
		waitingApproval: '!',
		completed: '✓',
		skipped: '–',
		error: '✕',
		aborted: '■',
	};

	const TYPE_LABELS = { ai: 'KI', gitPr: 'Git/PR', userApproval: 'Manuelles Gate' };

	const DEFAULT_EXPANDED_STATUSES = new Set(['active', 'waitingInput', 'waitingApproval', 'error', 'aborted']);

	const MAX_ATTACHED_IMAGES = 6;
	const MAX_ATTACHED_IMAGE_BYTES = 8 * 1024 * 1024;
	const COMPOSER_MAX_HEIGHT = 180;

	let state = {
		phase: 'idle',
		ticketText: '',
		images: [],
		stages: [],
		fileChanges: [],
		busy: false,
		abortRequested: false,
		autoMode: false,
		debugMode: false,
		usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
	};
	// Screenshots attached to the ticket before starting a run; sent along with 'start' and
	// cleared once the run begins (afterwards, state.images from the extension is authoritative).
	let attachedImages = [];
	const userExpanded = new Set();
	const userCollapsed = new Set();
	// A long-running "Implementierung" stage can rack up dozens of tool calls; showing every one
	// forever turned the activity feed into an ever-growing wall of text (the user's core
	// complaint). While a stage is still running we only tail the last few live steps; once it
	// settles we collapse to a one-line "N Aktionen ausgeführt" summary. Stage ids added here have
	// been explicitly expanded by the user and stay expanded until they re-collapse it or the
	// stage starts a fresh run.
	const activityExpanded = new Set();
	const MAX_LIVE_ACTIVITY_ITEMS = 4;

	let historyEntries = [];
	let viewMode = 'pipeline';
	let lastRenderedView = null;
	const expandedHistoryEntries = new Set();

	let pipelineDefinition = { stages: [] };
	let draftStages = [];
	let jsonEditMode = false;
	let saveStatus = null;
	let saveStatusTimer = null;
	// Id of the stage currently showing an inline "really delete?" confirmation. A plain
	// window.confirm() doesn't reliably work inside a VS Code webview (sandboxed iframe, no
	// allow-modals), so deleting a stage used a two-step in-page confirm instead.
	let pendingDeleteConfirm = null;

	// The composer is the single text input of the whole sidebar (chat-style). render() rebuilds
	// the DOM wholesale, so its draft text, caret and focus live here and get restored afterwards
	// — otherwise a state update mid-typing (they arrive many times per second while a stage runs)
	// would wipe what the user was writing.
	let composerDraft = '';
	let composerFocused = false;
	let composerSelection = null;
	// Auto-mode is chosen before a run starts; while a run is active state.autoMode wins.
	let pendingAutoMode = false;

	// While a stage with tool access runs, state updates can arrive many times per second (one
	// per tool call/round via the live activity feed). Rendering rebuilds the whole #app tree
	// (innerHTML = '' + re-append), so re-rendering on every single one of those messages made
	// buttons (e.g. the abort controls) flicker in and out and made clicks unreliable. Coalesce
	// bursts into at most one render per animation frame instead.
	let renderScheduled = false;
	function scheduleRender() {
		if (renderScheduled) {
			return;
		}
		renderScheduled = true;
		requestAnimationFrame(() => {
			renderScheduled = false;
			render();
		});
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message) {
			return;
		}
		if (message.type === 'state') {
			state = message.state;
			scheduleRender();
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

	// ------------------------------------------------------------------ Shell

	function render() {
		const app = document.getElementById('app');

		// Preserve the transcript scroll position across the full rebuild, and keep following the
		// newest output when the user was already parked at the bottom (chat behaviour).
		const previousMain = app.querySelector('.app-main');
		const sameView = lastRenderedView === viewMode;
		let previousScroll = 0;
		let wasAtBottom = true;
		if (previousMain && sameView) {
			previousScroll = previousMain.scrollTop;
			wasAtBottom = previousMain.scrollHeight - previousMain.scrollTop - previousMain.clientHeight < 24;
		}

		app.innerHTML = '';
		app.appendChild(renderHeader());

		const main = el('div', { class: 'app-main' });
		if (viewMode === 'history') {
			main.appendChild(renderHistoryView());
		} else if (viewMode === 'stages') {
			main.appendChild(renderStagesView());
		} else if (!state || state.phase === 'idle') {
			main.appendChild(renderWelcome());
		} else {
			main.appendChild(renderPipeline());
		}
		app.appendChild(main);

		if (viewMode === 'pipeline') {
			app.appendChild(renderComposer());
		}
		app.appendChild(renderStatusBar());

		if (sameView) {
			main.scrollTop = wasAtBottom ? main.scrollHeight : previousScroll;
		}
		lastRenderedView = viewMode;

		restoreComposerFocus();
	}

	function iconButton(glyph, title, onClick, active) {
		const btn = el('button', { class: active ? 'icon-btn active' : 'icon-btn', title, 'aria-label': title }, glyph);
		btn.addEventListener('click', onClick);
		return btn;
	}

	function renderHeader() {
		const header = el('div', { class: 'app-header' });

		const brandRow = el('div', { class: 'brand-row' });
		brandRow.appendChild(
			el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, '⚡'), el('span', { class: 'brand-name' }, 'Thunderstorm'))
		);

		const headerActions = el('div', { class: 'header-actions' });
		const newRunBtn = iconButton('＋', 'Neuer Vorgang (Pipeline zurücksetzen)', () => {
			composerDraft = '';
			attachedImages = [];
			vscode.postMessage({ type: 'reset' });
		});
		newRunBtn.disabled = !state || state.phase === 'idle';
		headerActions.appendChild(newRunBtn);
		headerActions.appendChild(
			iconButton(
				'⚙',
				state && state.debugMode ? 'Debug-Modus aktiv – klicken zum Deaktivieren' : 'Debug-Modus aktivieren',
				() => vscode.postMessage({ type: 'setDebugMode', enabled: !(state && state.debugMode) }),
				!!(state && state.debugMode)
			)
		);
		headerActions.appendChild(iconButton('⧉', 'Debug-Ausgabe öffnen', () => vscode.postMessage({ type: 'showDebugOutput' })));
		brandRow.appendChild(headerActions);
		header.appendChild(brandRow);

		const tabs = el('div', { class: 'view-tabs' });
		const makeTab = (mode, label, count) => {
			const btn = el('button', { class: viewMode === mode ? 'tab-btn active' : 'tab-btn' }, label);
			if (count) {
				btn.appendChild(el('span', { class: 'tab-count' }, String(count)));
			}
			btn.addEventListener('click', () => {
				viewMode = mode;
				render();
			});
			return btn;
		};
		tabs.appendChild(makeTab('pipeline', 'Pipeline'));
		tabs.appendChild(makeTab('history', 'Verlauf', historyEntries.length));
		tabs.appendChild(makeTab('stages', 'Stufen', (pipelineDefinition.stages || []).length));
		header.appendChild(tabs);

		return header;
	}

	function phaseIndicator() {
		if (!state || state.phase === 'idle') {
			return { glyph: '○', text: 'Bereit', on: false };
		}
		if (state.phase === 'running') {
			const waiting = (state.stages || []).find((s) => s.status === 'waitingInput' || s.status === 'waitingApproval');
			if (waiting) {
				return { glyph: '◆', text: 'Wartet auf Sie', on: true };
			}
			return { glyph: '◐', text: state.abortRequested ? 'Abbruch vorgemerkt' : 'Läuft …', on: true };
		}
		if (state.phase === 'aborted') {
			return { glyph: '■', text: 'Abgebrochen', on: false };
		}
		return { glyph: '✓', text: 'Abgeschlossen', on: false };
	}

	function renderStatusBar() {
		const bar = el('div', { class: 'app-status' });
		const phase = phaseIndicator();
		bar.appendChild(el('span', { class: phase.on ? 'status-item on' : 'status-item' }, `${phase.glyph} ${phase.text}`));

		const autoOn = state && state.phase !== 'idle' ? !!state.autoMode : pendingAutoMode;
		if (autoOn) {
			bar.appendChild(el('span', { class: 'status-item on', title: 'Bestätigungs-Gates laufen ohne Rückfrage durch.' }, '⚡ Auto'));
		}

		bar.appendChild(el('span', { class: 'status-spacer' }));

		if (state && state.usage && state.usage.requests > 0) {
			bar.appendChild(
				el(
					'span',
					{
						class: 'status-item',
						title: 'Anfragen = echte Copilot-Anfragen. Tokens = grobe Schätzung, keine offizielle Abrechnungsgröße.',
					},
					formatUsageText(state.usage)
				)
			);
		} else {
			bar.appendChild(
				el('span', { class: 'status-item' }, `${(pipelineDefinition.stages || []).length} Stufen konfiguriert`)
			);
		}
		return bar;
	}

	// --------------------------------------------------------------- Composer

	/** Works out what the composer's text currently means: starting a run, answering an open
	 *  question, requesting changes, or rejecting an approval gate. Returns `null` when there is
	 *  nothing to type (a stage is busy, or the run only offers buttons). */
	function composerTarget() {
		if (!state || state.phase === 'idle' || state.phase === 'done' || state.phase === 'aborted') {
			return {
				kind: 'start',
				placeholder: 'Beschreiben Sie das Ticket …',
				sendTitle: 'Pipeline starten (Enter)',
				allowImages: true,
			};
		}

		const stage = (state.stages || []).find((s) => s.status === 'waitingInput' || s.status === 'waitingApproval');
		if (!stage) {
			return null;
		}

		if (stage.status === 'waitingInput') {
			const def = findStageDef(stage.id);
			const isRetryGate = !!(def && def.gate && def.gate.onFail && def.gate.onFail.action === 'retryStage');
			if (isRetryGate) {
				return null;
			}
			return {
				kind: 'additionalInfo',
				stageId: stage.id,
				placeholder: 'Fehlende Informationen ergänzen …',
				sendTitle: 'Antwort senden und erneut prüfen (Enter)',
				tip: `„${stage.name}" braucht noch Angaben. Antwort hier eingeben – oder oben den Entwickler selbst entscheiden lassen.`,
			};
		}

		if (stage.type === 'userApproval') {
			const def = findStageDef(stage.id);
			const targetId = def && def.onReject ? def.onReject.targetStageId : undefined;
			const targetName = targetId ? (findStageDef(targetId) || {}).name || targetId : undefined;
			return {
				kind: 'reject',
				stageId: stage.id,
				placeholder: 'Begründung für die Ablehnung …',
				sendTitle: 'Ablehnen und Begründung senden (Enter)',
				tip: targetName
					? `Freigeben über den Button oben – oder hier begründen, dann geht es zurück an „${targetName}".`
					: 'Freigeben über den Button oben – oder hier begründen, warum die Änderungen abgelehnt werden.',
			};
		}

		return {
			kind: 'changes',
			stageId: stage.id,
			placeholder: 'Änderungen an dieser Stufe anfordern …',
			sendTitle: 'Änderungen anfordern (Enter)',
			tip: `„${stage.name}" wartet auf Bestätigung. Mit „Weiter" oben fortfahren – oder hier Änderungen anfordern.`,
		};
	}

	function sendComposer(target) {
		const text = composerDraft.trim();
		if (!target || !text || state.busy) {
			return;
		}
		if (target.kind === 'start') {
			vscode.postMessage({ type: 'start', text, autoMode: pendingAutoMode, images: attachedImages });
			attachedImages = [];
		} else if (target.kind === 'additionalInfo') {
			vscode.postMessage({ type: 'submitAdditionalInfo', stageId: target.stageId, text });
		} else if (target.kind === 'changes') {
			vscode.postMessage({ type: 'requestStageChanges', stageId: target.stageId, text });
		} else if (target.kind === 'reject') {
			vscode.postMessage({ type: 'rejectUserApproval', stageId: target.stageId, text });
		}
		composerDraft = '';
		composerSelection = null;
		render();
	}

	function autoGrow(textarea) {
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
	}

	function restoreComposerFocus() {
		const input = document.querySelector('.composer-input');
		if (!input) {
			return;
		}
		autoGrow(input);
		if (!composerFocused || input.disabled) {
			return;
		}
		input.focus();
		const pos = composerSelection === null ? input.value.length : Math.min(composerSelection, input.value.length);
		input.setSelectionRange(pos, pos);
	}

	function addImageFiles(files) {
		const room = MAX_ATTACHED_IMAGES - attachedImages.length;
		if (room <= 0) {
			return;
		}
		const accepted = files.filter((f) => f.type.startsWith('image/') && f.size <= MAX_ATTACHED_IMAGE_BYTES).slice(0, room);
		if (!accepted.length) {
			return;
		}
		Promise.all(accepted.map(readImageFile)).then((images) => {
			attachedImages = attachedImages.concat(images);
			render();
		});
	}

	function renderComposer() {
		const wrap = el('div', { class: 'app-composer' });
		const target = composerTarget();
		const disabled = !target || !!state.busy;

		const tipText = target
			? target.tip
			: state.abortRequested
			? 'Abbruch vorgemerkt – die Pipeline stoppt nach der aktuellen Stufe.'
			: 'Die Pipeline arbeitet. Sobald eine Stufe eine Rückmeldung braucht, können Sie hier antworten.';
		if (tipText) {
			wrap.appendChild(el('div', { class: 'composer-tip' }, tipText));
		} else if (target && target.kind === 'start') {
			wrap.appendChild(
				el(
					'div',
					{ class: 'composer-tip' },
					el('strong', {}, 'Tipp: '),
					'Screenshots per Strg+V direkt einfügen. Enter startet, Umschalt+Enter macht eine neue Zeile.'
				)
			);
		}

		const box = el('div', { class: disabled ? 'composer-box disabled' : 'composer-box' });

		const allowImages = !!(target && target.allowImages);
		if (allowImages && attachedImages.length) {
			box.appendChild(
				el(
					'div',
					{ class: 'composer-attachments' },
					...attachedImages.map((img) =>
						imageThumb(img, () => {
							attachedImages = attachedImages.filter((i) => i.id !== img.id);
							render();
						})
					)
				)
			);
		}

		const input = el('textarea', {
			class: 'composer-input',
			rows: '1',
			placeholder: target ? target.placeholder : 'Pipeline läuft …',
		});
		input.value = composerDraft;
		input.disabled = disabled;
		input.addEventListener('input', () => {
			composerDraft = input.value;
			composerSelection = input.selectionStart;
			autoGrow(input);
			sendBtn.disabled = disabled || !composerDraft.trim();
		});
		input.addEventListener('keyup', () => {
			composerSelection = input.selectionStart;
		});
		input.addEventListener('click', () => {
			composerSelection = input.selectionStart;
		});
		input.addEventListener('focus', () => {
			composerFocused = true;
		});
		input.addEventListener('blur', () => {
			composerFocused = false;
		});
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				sendComposer(target);
			}
		});

		if (allowImages) {
			input.addEventListener('paste', (event) => {
				const items = event.clipboardData && event.clipboardData.items;
				if (!items) {
					return;
				}
				const files = [];
				for (const item of items) {
					if (item.kind === 'file' && item.type.startsWith('image/')) {
						const file = item.getAsFile();
						if (file) {
							files.push(file);
						}
					}
				}
				if (files.length) {
					event.preventDefault();
					composerDraft = input.value;
					addImageFiles(files);
				}
			});
			input.addEventListener('dragover', (event) => event.preventDefault());
			input.addEventListener('drop', (event) => {
				const files = event.dataTransfer && event.dataTransfer.files;
				if (files && files.length) {
					event.preventDefault();
					composerDraft = input.value;
					addImageFiles(Array.from(files));
				}
			});
		}
		box.appendChild(input);

		const toolbar = el('div', { class: 'composer-toolbar' });

		const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: 'multiple', style: 'display:none' });
		fileInput.addEventListener('change', () => {
			if (fileInput.files && fileInput.files.length) {
				addImageFiles(Array.from(fileInput.files));
				fileInput.value = '';
			}
		});
		const attachBtn = iconButton('＋', `Bild/Screenshot anhängen (max. ${MAX_ATTACHED_IMAGES})`, () => fileInput.click());
		attachBtn.disabled = !allowImages || attachedImages.length >= MAX_ATTACHED_IMAGES;
		toolbar.appendChild(attachBtn);
		toolbar.appendChild(fileInput);

		if (target && target.kind === 'start') {
			const autoChip = el(
				'button',
				{
					class: pendingAutoMode ? 'composer-chip on' : 'composer-chip',
					title: 'Auto-Modus: Bestätigungs-Gates automatisch durchlaufen, ohne nach jeder Stufe nachzufragen.',
				},
				'⚡ Auto-Modus'
			);
			autoChip.addEventListener('click', () => {
				pendingAutoMode = !pendingAutoMode;
				render();
			});
			toolbar.appendChild(autoChip);

			const stageCount = (pipelineDefinition.stages || []).length;
			const stagesChip = el(
				'button',
				{ class: 'composer-chip static', title: 'Konfigurierte Stufenkette anzeigen' },
				`◇ ${stageCount} Stufen`
			);
			stagesChip.addEventListener('click', () => {
				viewMode = 'stages';
				render();
			});
			toolbar.appendChild(stagesChip);
		} else if (target) {
			const targetStage = (state.stages || []).find((s) => s.id === target.stageId);
			toolbar.appendChild(
				el(
					'span',
					{ class: 'composer-chip static', title: 'Diese Stufe erhält Ihre Eingabe' },
					`↳ ${targetStage ? targetStage.name : 'Aktuelle Stufe'}`
				)
			);
		}

		toolbar.appendChild(el('span', { class: 'composer-toolbar-spacer' }));

		const sendBtn = el('button', { class: 'composer-send', title: target ? target.sendTitle : 'Nicht verfügbar' }, '↑');
		sendBtn.disabled = disabled || !composerDraft.trim();
		sendBtn.addEventListener('click', () => sendComposer(target));
		toolbar.appendChild(sendBtn);

		box.appendChild(toolbar);
		wrap.appendChild(box);
		return wrap;
	}

	// ---------------------------------------------------------------- History

	function renderHistoryView() {
		const container = el('div');
		if (historyEntries.length === 0) {
			container.appendChild(
				el('div', { class: 'empty-state' }, 'Noch keine Einträge. Der Verlauf füllt sich, sobald die Pipeline eine KI-Anfrage stellt.')
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

		const byId = new Map(historyEntries.map((e) => [e.id, e]));
		const list = el('div', { class: 'history-list' });
		const newestFirst = historyEntries.slice().reverse();
		for (const entry of newestFirst) {
			list.appendChild(renderHistoryEntry(entry, byId));
		}
		container.appendChild(list);
		return container;
	}

	function renderHistoryEntry(entry, byId) {
		const causingEntry = entry.causedByEntryId ? byId.get(entry.causedByEntryId) : undefined;
		const card = el('div', { class: causingEntry ? 'history-entry history-entry-retry' : 'history-entry' });

		const header = el('div', { class: 'history-entry-header' });
		header.appendChild(el('span', { class: 'history-entry-title' }, entry.title));
		header.appendChild(el('span', { class: 'history-entry-time' }, new Date(entry.timestamp).toLocaleTimeString()));
		card.appendChild(header);

		if (causingEntry) {
			const exchangeBox = el('div', { class: 'history-exchange-box' });
			exchangeBox.appendChild(
				el('div', { class: 'history-exchange-label' }, `🔁 Korrektur – ausgelöst durch Rückmeldung von „${causingEntry.title}“`)
			);
			const expanded = expandedHistoryEntries.has(`exchange:${entry.id}`);
			const toggleBtn = el('button', { class: 'link' }, expanded ? 'Austausch ausblenden' : 'Austausch anzeigen (beide Seiten)');
			toggleBtn.addEventListener('click', () => {
				if (expanded) {
					expandedHistoryEntries.delete(`exchange:${entry.id}`);
				} else {
					expandedHistoryEntries.add(`exchange:${entry.id}`);
				}
				render();
			});
			exchangeBox.appendChild(toggleBtn);
			if (expanded) {
				const causingBox = el('div', { class: 'history-exchange-side' });
				causingBox.appendChild(el('div', { class: 'history-field-label' }, `${causingEntry.title} sagte`));
				causingBox.appendChild(el('div', { class: 'history-field-value' }, causingEntry.result));
				exchangeBox.appendChild(causingBox);
				const responseBox = el('div', { class: 'history-exchange-side' });
				responseBox.appendChild(el('div', { class: 'history-field-label' }, `${entry.title} antwortete`));
				responseBox.appendChild(el('div', { class: 'history-field-value' }, entry.result));
				exchangeBox.appendChild(responseBox);
			}
			card.appendChild(exchangeBox);
		}

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

	// ------------------------------------------------------------ Attachments

	function readImageFile(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = String(reader.result || '');
				const commaIdx = result.indexOf(',');
				resolve({
					id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					name: file.name || 'Screenshot',
					mimeType: file.type || 'image/png',
					data: commaIdx >= 0 ? result.slice(commaIdx + 1) : result,
				});
			};
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
	}

	function imageThumb(img, onRemove) {
		const thumb = el('div', { class: 'image-thumb' });
		thumb.appendChild(el('img', { src: `data:${img.mimeType};base64,${img.data}`, title: img.name }));
		if (onRemove) {
			const removeBtn = el('button', { class: 'image-thumb-remove', title: 'Entfernen' }, '✕');
			removeBtn.addEventListener('click', onRemove);
			thumb.appendChild(removeBtn);
		}
		return thumb;
	}

	function renderImageThumbs(images, onRemove) {
		const row = el('div', { class: 'image-attachments' });
		for (const img of images) {
			row.appendChild(imageThumb(img, onRemove ? () => onRemove(img) : null));
		}
		return row;
	}

	// --------------------------------------------------------------- Welcome

	function renderWelcome() {
		const container = el('div', { class: 'welcome' });
		container.appendChild(el('div', { class: 'welcome-title' }, 'Womit sollen wir anfangen?'));
		container.appendChild(
			el(
				'p',
				{ class: 'welcome-text' },
				'Beschreiben Sie unten das umzusetzende Ticket. Thunderstorm arbeitet die konfigurierte Stufenkette ab und bereitet am Ende einen Pull Request vor.'
			)
		);

		const stages = pipelineDefinition.stages || [];
		if (stages.length) {
			const chain = el('div', { class: 'welcome-chain' });
			stages.forEach((stage, index) => {
				chain.appendChild(
					el(
						'span',
						{ class: 'chain-chip', title: `${TYPE_LABELS[stage.type] || stage.type} · id: ${stage.id}` },
						el('span', { class: 'chain-chip-index' }, String(index + 1)),
						stage.name
					)
				);
			});
			container.appendChild(chain);
		}
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

		const head = el('div', { class: 'run-head' });
		head.appendChild(el('div', { class: 'bubble-label' }, 'Ticket'));
		head.appendChild(el('div', { class: 'ticket-bubble' }, state.ticketText));
		if (state.images && state.images.length) {
			head.appendChild(renderImageThumbs(state.images, null));
		}
		container.appendChild(head);

		if (state.usage && state.usage.requests > 0) {
			container.appendChild(renderUsageBadge(state.usage));
		}

		if (state.autoMode && state.phase === 'running') {
			container.appendChild(
				el('div', { class: 'auto-mode-badge' }, '⚡ Auto-Modus aktiv: Bestätigungs-Gates laufen ohne Rückfrage durch.')
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
				el('div', { class: 'done-banner' }, '✓ Vorgang abgeschlossen. Unten können Sie direkt einen neuen Vorgang starten.')
			);
		}

		if (state.phase === 'aborted') {
			container.appendChild(
				el('div', { class: 'aborted-banner' }, '■ Vorgang abgebrochen. Unten können Sie direkt einen neuen Vorgang starten.')
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
		if (stage.status === 'active' && (!stage.activity || stage.activity.length === 0)) {
			// Fresh run of this stage just started — don't carry over an expand choice from a
			// previous round's (possibly much longer) activity trace.
			activityExpanded.delete(stage.id);
		}

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

		if (stage.activity && stage.activity.length) {
			frag.appendChild(renderActivity(stage));
		} else if (stage.status === 'active') {
			frag.appendChild(el('div', { class: 'busy-indicator' }, 'Wird verarbeitet …'));
		}

		if (stage.usage && stage.usage.requests > 0) {
			frag.appendChild(
				el(
					'div',
					{
						class: 'stage-usage-line',
						title:
							'Anfragen = von dieser Stufe bisher verbrauchte GitHub-Copilot-Credits (echte "Premium Requests"), live mitgezählt während die Stufe läuft. Tokens = grobe Schätzung, keine offizielle Abrechnungsgröße.',
					},
					`💳 ${formatUsageText(stage.usage)}`
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

	/** Renders a stage's live activity feed. While the stage is still running, only the most
	 *  recent {@link MAX_LIVE_ACTIVITY_ITEMS} steps are shown (older ones fold into a "… N frühere
	 *  Schritte" line) so a long tool-calling run doesn't turn into an endless scrolling list.
	 *  Once the stage settles, the whole feed collapses to a one-line summary that the user can
	 *  expand on demand to see the full trace. */
	function renderActivity(stage) {
		const items = stage.activity;
		const isRunning = stage.status === 'active';
		const expanded = activityExpanded.has(stage.id);
		const frag = el('div', { class: 'activity-wrap' });

		if (!isRunning && !expanded) {
			const errorCount = items.filter((a) => a.status === 'error').length;
			const summaryText = errorCount
				? `${items.length} Aktion(en) ausgeführt, ${errorCount} fehlgeschlagen`
				: `${items.length} Aktion(en) ausgeführt`;
			const toggle = el('button', { class: 'link activity-toggle' }, `▸ ${summaryText}`);
			toggle.addEventListener('click', (e) => {
				e.stopPropagation();
				activityExpanded.add(stage.id);
				render();
			});
			frag.appendChild(toggle);
			return frag;
		}

		const visible = expanded ? items : items.slice(-MAX_LIVE_ACTIVITY_ITEMS);
		const hiddenCount = items.length - visible.length;
		if (hiddenCount > 0) {
			frag.appendChild(el('div', { class: 'activity-more muted' }, `… ${hiddenCount} frühere Schritt(e) ausgeblendet`));
		}
		const activityList = el('ul', { class: 'activity-list' });
		for (const a of visible) {
			activityList.appendChild(el('li', { class: `activity-item activity-${a.status}` }, a.label));
		}
		frag.appendChild(activityList);

		if (expanded && !isRunning) {
			const collapseBtn = el('button', { class: 'link activity-toggle' }, '▾ Einklappen');
			collapseBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				activityExpanded.delete(stage.id);
				render();
			});
			frag.appendChild(collapseBtn);
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
			// Änderungen werden über den Composer am unteren Rand angefordert.
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
				autonomyBtn.title =
					'Überspringt die Rückfrage. Die nächste Stufe bekommt Ticket-Text und alle bisher gegebenen Informationen wie gewohnt, plus den Hinweis, offene Punkte selbst zu entscheiden.';
				autonomyBtn.addEventListener('click', () => vscode.postMessage({ type: 'proceedAutonomously', stageId: stage.id }));
				wrap.appendChild(el('div', { class: 'actions' }, autonomyBtn));
				// Fehlende Informationen werden über den Composer am unteren Rand ergänzt.
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
		const actions = el('div', { class: 'actions' });
		if (state.fileChanges && state.fileChanges.length) {
			const diffBtn = el('button', { class: 'secondary' }, 'Diff anzeigen');
			diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }));
			actions.appendChild(diffBtn);
		}
		if (stage.status === 'waitingApproval') {
			const btn = el('button', {}, 'Freigeben');
			btn.disabled = !!state.busy;
			btn.addEventListener('click', () => vscode.postMessage({ type: 'completeUserApproval', stageId: stage.id }));
			actions.appendChild(btn);
		}
		if (actions.childNodes.length) {
			wrap.appendChild(actions);
		}
		// Ablehnen inkl. Begründung läuft über den Composer am unteren Rand.
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
			const base = stage.instructions || '(keine Hinweise hinterlegt)';
			return stage.onReject && stage.onReject.targetStageId
				? `${base} · Ablehnen → „${stage.onReject.targetStageId}“`
				: base;
		}
		return '';
	}

	function renderStagesView() {
		const container = el('div');
		container.appendChild(
			el(
				'div',
				{ class: 'section-intro' },
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
		const upBtn = el('button', { class: 'secondary', title: 'Nach oben' }, '↑');
		upBtn.disabled = index === 0;
		upBtn.addEventListener('click', () => {
			const copy = draftStages.slice();
			[copy[index - 1], copy[index]] = [copy[index], copy[index - 1]];
			draftStages = copy;
			saveDraftStages();
		});
		const downBtn = el('button', { class: 'secondary', title: 'Nach unten' }, '↓');
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
			pendingDeleteConfirm = stage.id;
			render();
		});
		actions.appendChild(upBtn);
		actions.appendChild(downBtn);
		actions.appendChild(dupBtn);
		actions.appendChild(delBtn);
		card.appendChild(actions);

		if (pendingDeleteConfirm === stage.id) {
			const confirmRow = el('div', { class: 'actions confirm-row' });
			confirmRow.appendChild(el('span', { class: 'confirm-text' }, `Stufe „${stage.name}" wirklich löschen?`));
			const yesBtn = el('button', { class: 'danger' }, 'Ja, löschen');
			yesBtn.addEventListener('click', () => {
				pendingDeleteConfirm = null;
				draftStages = draftStages.filter((_, i) => i !== index);
				saveDraftStages();
			});
			const noBtn = el('button', { class: 'secondary' }, 'Abbrechen');
			noBtn.addEventListener('click', () => {
				pendingDeleteConfirm = null;
				render();
			});
			confirmRow.appendChild(yesBtn);
			confirmRow.appendChild(noBtn);
			card.appendChild(confirmRow);
		}

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
