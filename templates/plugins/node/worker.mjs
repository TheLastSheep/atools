import readline from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [{
  name: "echo",
  description: "Echo structured input through the Node sidecar",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { message: { type: "string" }, runtime: { const: "node" } },
    required: ["message", "runtime"],
  },
}];

async function handle(message) {
  if (!Object.hasOwn(message, "id")) return;
  if (message.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "atools-node-echo", version: "0.1.0" },
    };
  }
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    if (message.params?.name !== "echo") throw new Error(`Unknown tool: ${message.params?.name}`);
    const output = { message: String(message.params?.arguments?.message || ""), runtime: "node" };
    return {
      content: [{ type: "text", text: output.message }],
      structuredContent: output,
      isError: false,
    };
  }
  throw new Error(`Unknown method: ${message.method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
    const result = await handle(message);
    if (Object.hasOwn(message, "id")) send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    if (message && Object.hasOwn(message, "id")) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } });
    } else {
      process.stderr.write(`${error.stack || error}\n`);
    }
  }
}
