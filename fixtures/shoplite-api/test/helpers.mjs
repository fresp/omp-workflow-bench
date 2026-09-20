import { createServer } from "node:http";
import { createApp } from "../src/app.mjs";

/** Boot the app in-process on a random port. */
export async function startApp(options = {}) {
	const app = createApp({ logger: { error() {} }, ...options });
	const server = createServer(app.handle);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const url = `http://127.0.0.1:${port}`;
	return {
		url,
		app,
		store: app.store,
		request: (path, init = {}) =>
			fetch(url + path, {
				...init,
				headers: { "content-type": "application/json", ...(init.headers ?? {}) },
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			}),
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
