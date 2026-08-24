export class JsonExtractionError extends Error {
	constructor(message: string, public readonly raw: string) {
		super(message);
	}
}

/**
 * Model responses sometimes wrap JSON in markdown code fences or add stray
 * prose before/after. Strip fences and take the outermost {...} block.
 */
export function extractJson<T>(text: string): T {
	let candidate = text.trim();
	const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch) {
		candidate = fenceMatch[1].trim();
	}

	const start = candidate.indexOf('{');
	const end = candidate.lastIndexOf('}');
	if (start === -1 || end === -1 || end < start) {
		throw new JsonExtractionError('Antwort des Sprachmodells enthält kein JSON-Objekt.', text);
	}
	candidate = candidate.slice(start, end + 1);

	try {
		return JSON.parse(candidate) as T;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new JsonExtractionError(`Antwort des Sprachmodells konnte nicht als JSON gelesen werden: ${message}`, text);
	}
}
