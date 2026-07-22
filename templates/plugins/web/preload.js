window.utools.registerTool("echo", async ({ message = "" } = {}) => ({
  content: [{ type: "text", text: String(message) }],
  structuredContent: { message: String(message), runtime: "web" },
  isError: false,
}));
