import { createServer } from "node:http";
import { createApp } from "./app.mjs";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
createServer(app.handle).listen(port, () => {
	console.log(`shoplite-api listening on :${port}`);
});
