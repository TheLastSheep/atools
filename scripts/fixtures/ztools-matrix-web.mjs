// Every probe runs inside the original plugin page; no replacement business code.
export const webCases = [
  { id: "2048", category: "pure-web-dom", ui: true, assertion: "business_function", async probe(ctx) {
    await ctx.test("original-game-merge-updates-game-state", () => {
      const game = new window.GameManager(4, window.KeyboardInputManager, window.HTMLActuator, window.LocalStorageManager);
      game.grid = new window.Grid(4); game.score = 0; game.over = false; game.won = false;
      game.grid.insertTile(new window.Tile({ x: 0, y: 0 }, 2));
      game.grid.insertTile(new window.Tile({ x: 0, y: 1 }, 2));
      game.move(0);
      ctx.check(game.score === 4 && game.grid.cellContent({ x: 0, y: 0 }).value === 4, "2 + 2 must merge to 4");
      return { score: game.score, mergedValue: game.grid.cellContent({ x: 0, y: 0 }).value };
    });
  } },
  { id: "uuid-kit", category: "pure-web-codec-dom", ui: true, async probe(ctx) {
    await ctx.test("original-named-uuid5-ui", async () => {
      const input = document.querySelector("#input");
      input.value = "uuid5 dns example.com"; input.dispatchEvent(new Event("input", { bubbles: true }));
      await ctx.waitFor(() => document.querySelector("#out")?.textContent.includes("cfbff0d1-9375-5685-968c-48ce8b15ae17"));
      return { uuid: "cfbff0d1-9375-5685-968c-48ce8b15ae17" };
    });
  } },
  { id: "developer-codec-tools", category: "pure-web-esm-dom", ui: true, async probe(ctx) {
    await ctx.test("original-base64-button-and-swap", async () => {
      document.querySelector("#inputText").value = ctx.config.text;
      document.querySelector("#operation").value = "base64-encode";
      document.querySelector("#runOperation").click();
      await ctx.waitFor(() => document.querySelector("#outputText")?.value === ctx.config.base64);
      document.querySelector("#swapText").click();
      ctx.check(document.querySelector("#inputText").value === ctx.config.base64, "Swap must use the original rendered output");
      return { encoded: document.querySelector("#inputText").value };
    });
  } },
  { id: "content-workbench", category: "pure-web-esm-dom", ui: true, async probe(ctx) {
    await ctx.test("original-markdown-plain-button", () => {
      document.querySelector("#input").value = "# Hello\n\n**世界**";
      document.querySelector("#plain").click();
      const text = document.querySelector("#output").textContent;
      ctx.check(text.includes("Hello") && text.includes("世界") && !text.includes("**"), "Markdown syntax must be removed");
      return { text };
    });
  } },
  { id: "dev-data-workbench", category: "pure-web-esm-dom", ui: true, async probe(ctx) {
    await ctx.test("original-json-typescript-button", () => {
      document.querySelector("#input").value = '{"id":7,"name":"sample","active":true}';
      document.querySelector("#to-ts").click();
      const text = document.querySelector("#output").textContent;
      ctx.check(text.includes("interface Root") && text.includes("id: number") && text.includes("active: boolean"), "Original schema generator output differs");
      return { text };
    });
  } },
  { id: "file-workbench", category: "pure-web-esm-dom", ui: true, async probe(ctx) {
    await ctx.test("original-file-tree-and-byte-format-buttons", () => {
      document.querySelector("#input").value = "/repo/src/main.js\n/repo/README.md";
      document.querySelector("#tree").click();
      const tree = document.querySelector("#output").textContent;
      ctx.check(tree.includes("main.js") && tree.includes("README.md"), "File tree must include both source paths");
      document.querySelector("#bytes").click();
      const bytes = document.querySelector("#output").textContent;
      ctx.check(bytes.includes("1.5") && /KB|KiB/.test(bytes), "1536-byte formatter differs");
      return { tree, bytes };
    });
  } },
  { id: "knowledge-workbench", category: "pure-web-esm-dom", ui: true, async probe(ctx) {
    await ctx.test("original-html-markdown-button", () => {
      document.querySelector("#input").value = '<h1>Hello</h1><p><a href="https://example.test">站酷</a></p>';
      document.querySelector("#markdown").click();
      const markdown = document.querySelector("#output").textContent;
      ctx.check(markdown.includes("# Hello") && markdown.includes("[站酷](https://example.test)"), "Original HTML converter differs");
      return { markdown };
    });
  } },
  { id: "project-launchpad", category: "pure-web-esm-dom", ui: true, async probe(ctx) {
    await ctx.test("original-launch-plan-without-execution", () => {
      document.querySelector("#input").value = JSON.stringify({ name: "fixture", rootPath: "/scratch/project", ports: [5173], urls: ["http://localhost:5173"] });
      document.querySelector("#actions").click();
      const actions = JSON.parse(document.querySelector("#output").textContent);
      ctx.check(actions.some(item => item.type === "check-port" && item.port === 5173), "Launch plan must retain the supplied port");
      ctx.check(actions.some(item => item.type === "open-editor"), "Launch plan must include editor action");
      return { actionTypes: actions.map(item => item.type) };
    });
  } },
  { id: "cron", category: "pure-web-dom", ui: true, async probe(ctx) {
    await ctx.test("original-linux-cron-version-change", () => {
      const selector = document.querySelector("#cronVersion");
      selector.value = "linux"; selector.dispatchEvent(new Event("change", { bubbles: true }));
      const expression = document.querySelector("#cronResult").value;
      ctx.check(expression.trim().split(/\s+/).length === 5, "Linux selection must generate five cron fields");
      document.querySelector("#resetBtn").click();
      ctx.check(selector.value === "quartz", "Reset must restore the original default version");
      return { expression };
    });
  } },
  { id: "address-parser", category: "cjs-node-and-dom", ui: true, async probe(ctx) {
    await ctx.test("original-labelled-address-parser-ui", () => {
      document.querySelector("#source-input").value = "收货人：张三 手机：13800138000 地址：广东省深圳市南山区粤海街道科技园1号";
      document.querySelector("#parse-button").click();
      const rows = window.AddressParserCore.parseBatch(document.querySelector("#source-input").value);
      ctx.check(rows.length === 1 && rows[0].phone === "13800138000" && rows[0].province === "广东省", "Original address parse differs");
      ctx.check(document.querySelector("#total-count").textContent === "1", "Original UI must render the parsed count");
      return { phone: rows[0].phone, province: rows[0].province, renderedCount: 1 };
    });
  } },
];
