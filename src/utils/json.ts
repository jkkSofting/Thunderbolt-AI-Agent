import { GateVerdict } from '../types';

export class JsonExtractionError extends Error {
	constructor(message: string, public readonly raw: string) {
		super(message);
	}
}

function truncateForFeedback(text: string, max = 800): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}\n… (gekürzt)` : trimmed;
}

/** Scans for the first top-level `{...}` object, respecting string literals (so braces inside
 *  quoted strings don't end the scan early/late) — more robust than `indexOf('{')`/
 *  `lastIndexOf('}')`, which mismatches as soon as any prose after the JSON contains a stray
 *  brace (e.g. a code sample in "details"). */
function findBalancedJsonObject(text: string): string | undefined {
	const start = text.indexOf('{');
	if (start === -1) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escapeNext = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escapeNext) {
				escapeNext = false;
			} else if (ch === '\\') {
				escapeNext = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

/**
 * Model responses sometimes wrap JSON in markdown code fences or add stray
 * prose before/after. Strip fences and take the outermost balanced {...} block.
 */
export function extractJson<T>(text: string): T {
	let candidate = text.trim();
	const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch) {
		candidate = fenceMatch[1].trim();
	}

	const jsonSpan = findBalancedJsonObject(candidate);
	if (!jsonSpan) {
		throw new JsonExtractionError('Antwort des Sprachmodells enthält kein JSON-Objekt.', text);
	}

	try {
		return JSON.parse(jsonSpan) as T;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new JsonExtractionError(`Antwort des Sprachmodells konnte nicht als JSON gelesen werden: ${message}`, text);
	}
}

function regexExtractString(text: string, key: string): string | undefined {
	const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
	return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : undefined;
}

function regexExtractBool(text: string, key: string): boolean | undefined {
	const m = text.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`, 'i'));
	return m ? m[1].toLowerCase() === 'true' : undefined;
}

function regexExtractStringArray(text: string, key: string): string[] | undefined {
	const m = text.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i'));
	if (!m) {
		return undefined;
	}
	const items: string[] = [];
	const itemRe = /"((?:[^"\\]|\\.)*)"/g;
	let mm: RegExpExecArray | null;
	while ((mm = itemRe.exec(m[1]))) {
		items.push(mm[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'));
	}
	return items;
}

/** Parses the gate JSON contract `{ok, feedback, details}` a gated 'ai' stage is instructed to
 *  append to its answer. Never throws: a gate's job is to decide whether the pipeline continues,
 *  so a badly-formatted verdict must still leave the pipeline in a sane (paused, reviewable)
 *  state instead of crashing the whole run.
 *
 *  Fallback chain: (1) clean JSON via {@link extractJson}, with missing/wrong-typed fields
 *  defaulted conservatively (`ok` defaults to false — never silently treat an unreadable verdict
 *  as "passed"); (2) if that fails, best-effort regex field extraction from the raw text; (3) if
 *  even that finds nothing usable, a synthetic `ok:false` verdict carrying the raw response as
 *  feedback, so the user can still see what the model said and decide manually. */
export function parseGateVerdict(rawText: string): GateVerdict {
	try {
		const parsed = extractJson<Partial<GateVerdict>>(rawText);
		return {
			ok: typeof parsed.ok === 'boolean' ? parsed.ok : false,
			feedback:
				typeof parsed.feedback === 'string' && parsed.feedback.trim()
					? parsed.feedback
					: regexExtractString(rawText, 'feedback') ?? '(Modell hat kein "feedback"-Feld geliefert.)',
			details: Array.isArray(parsed.details)
				? parsed.details.filter((d): d is string => typeof d === 'string')
				: regexExtractStringArray(rawText, 'details') ?? [],
		};
	} catch {
		const ok = regexExtractBool(rawText, 'ok');
		const feedback = regexExtractString(rawText, 'feedback');
		const details = regexExtractStringArray(rawText, 'details');
		if (ok !== undefined || feedback !== undefined) {
			return {
				ok: ok ?? false,
				feedback: `${feedback ?? '(Bewertung des Modells konnte nicht sauber gelesen werden.)'} [Hinweis: Antwort war kein valides JSON, Felder wurden notdürftig extrahiert.]`,
				details: details ?? [],
			};
		}
		return {
			ok: false,
			feedback: `Die Bewertung des Modells konnte nicht als JSON gelesen werden. Rohantwort: ${truncateForFeedback(rawText)}`,
			details: [],
		};
	}
}
