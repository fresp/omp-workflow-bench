export function register(router) {
	router.get("/health", async (ctx) => {
		ctx.result = { status: "ok" };
	});
}
