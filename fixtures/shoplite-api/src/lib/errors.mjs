export class HttpError extends Error {
	/**
	 * @param {number} status HTTP status
	 * @param {string} code UPPER_SNAKE_CASE machine-readable code
	 * @param {string} message human readable message
	 * @param {Record<string,string>} [headers] extra response headers
	 */
	constructor(status, code, message, headers = {}) {
		super(message);
		this.status = status;
		this.code = code;
		this.headers = headers;
	}
}

export const notFound = (what) => new HttpError(404, "NOT_FOUND", `${what} not found`);
export const badRequest = (message, code = "BAD_REQUEST") => new HttpError(400, code, message);
export const conflict = (message) => new HttpError(409, "CONFLICT", message);

export function errorBody(err) {
	return { error: { code: err.code, message: err.message } };
}
