import { badRequest } from "./errors.mjs";

export async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return undefined;
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.trim() === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		throw badRequest("Request body is not valid JSON", "INVALID_JSON");
	}
}

export function sendJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		...headers,
	});
	res.end(payload);
}
