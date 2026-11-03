// Positive original-page behavior; every function is serialized into its opaque frame.
export const offlineWebCases = [
  { id: "ai-automation-workbench", category: "web-prompt-template", ui: true, async probe(ctx) {
    await ctx.test("original-prompt-template-fills-supplied-variables", () => {
      document.querySelector("#input").value = "Review {{file}} for {{focus}}.";
      document.querySelector("#prompt").click();
      const output = document.querySelector("#output").textContent;
      ctx.check(output.includes("app.ts") && output.includes("bugs") && !output.includes("{{"), "Original variable filling differs"); return { output };
    });
  } },
  { id: "image-delivery-workbench", category: "web-color-css", ui: true, async probe(ctx) {
    await ctx.test("original-color-extraction-generates-css-variables", () => {
      document.querySelector("#input").value = "primary #3366ff, bg #fff";
      document.querySelector("#css").click(); const output = document.querySelector("#output").textContent;
      ctx.check(output.includes("--") && output.includes("#3366ff") && /#fff/i.test(output), "Original palette CSS differs"); return { output };
    });
  } },
  { id: "calculation-paper", category: "released-react-calculator", ui: true, async probe(ctx) {
    await ctx.test("original-calculation-paper-evaluates-input", async () => {
      const input = document.querySelector('textarea[placeholder="计算公式"]');
      ctx.check(input, "Original calculator input unavailable");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "123+456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      await ctx.waitFor(() => document.body.innerText.includes("579"));
      return { expression: "123+456", expected: "579", rendered: true };
    });
  } },
  { id: "fidget", category: "web-snail-geometry", ui: true, coverage: "Original renderer geometry/time functions; native overlay window creation is not asserted", async probe(ctx) {
    await ctx.test("original-snail-angle-direction-and-countdown", () => {
      const angle = window.normalizeAngle(450), direction = window.getDirectionImage(angle), time = window.formatTime(61001);
      ctx.check(angle === 90 && direction === "bottom" && time === "1分2秒", "Original snail renderer calculations differ"); return { angle, direction, time };
    });
  } },
  { id: "image-stitch", category: "web-real-canvas-file-drop", ui: true, async probe(ctx) {
    await ctx.test("original-drop-stitches-two-real-pngs", async () => {
      const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2;
      const context = canvas.getContext("2d"); context.fillStyle = "#ff0000"; context.fillRect(0, 0, 2, 2);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const files = [new File([blob], "one.png", { type: "image/png" }), new File([blob], "two.png", { type: "image/png" })];
      const transfer = new DataTransfer(); files.forEach(file => transfer.items.add(file));
      const event = new Event("drop", { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: transfer });
      document.querySelector("#preview-area").dispatchEvent(event);
      await ctx.waitFor(() => document.querySelectorAll(".image-item").length === 2);
      const output = document.querySelector("#canvas");
      ctx.check(output.width === 2 && output.height === 4, "Original vertical stitch dimensions differ");
      ctx.check(output.getContext("2d").getImageData(0, 3, 1, 1).data[0] === 255, "Original stitched pixel differs");
      document.querySelector("#btn-clear").click();
      ctx.check(document.querySelectorAll(".image-item").length === 0, "Clear must remove original images"); return { width: 2, height: 4, pixelRed: 255, cleared: true };
    });
  } },
  { id: "rogue-shooter", category: "web-game-hp-level-dom", ui: true, async probe(ctx) {
    await ctx.test("original-player-damage-and-level-up-update-ui", () => {
      window.startGame();
      player.takeDamage(25); player.gainXp(20);
      ctx.check(player.hp === 75 && player.level === 2 && document.querySelector("#hp-bar").style.width === "75%", "Original game HP and level progression differ");
      ctx.check(document.querySelector("#upgrade-menu").style.display === "flex", "Original upgrade UI must open");
      window.setGameState("paused"); return { hp: player.hp, level: player.level, upgradeVisible: true };
    });
  } },
  { id: "subnet-calculator", category: "web-ipv4-network-dom", ui: true, async probe(ctx) {
    await ctx.test("original-subnet-calculation-renders-network-broadcast-hosts", () => {
      document.querySelector("#ipInput").value = "192.168.1.100"; document.querySelector("#maskInput").value = "24"; window.calculate();
      const output = document.querySelector("#resultArea").innerText;
      ctx.check(output.includes("192.168.1.0") && output.includes("192.168.1.255") && output.includes("254"), "Original /24 result differs"); return { network: "192.168.1.0", broadcast: "192.168.1.255", hosts: 254 };
    });
  } },
  { id: "share-sanitizer", category: "web-esm-sensitive-redaction", ui: true, async probe(ctx) {
    await ctx.test("original-sensitive-scan-and-redaction-ui", () => {
      const input = document.querySelector("#input"); input.value = "联系 alice@example.invalid 或 13800138000";
      document.querySelector("#scan").click(); const count = document.querySelectorAll("#findings li").length;
      ctx.check(count >= 2, "Original detector must find email and phone"); document.querySelector("#redact").click();
      ctx.check(!input.value.includes("alice@example.invalid") && !input.value.includes("13800138000") && input.value.includes("【已脱敏】"), "Original redactor must replace actual sensitive values"); return { findings: count, text: input.value };
    });
  } },
  { id: "zhi-interaction", category: "original-mcp-validation", ui: true, async probe(ctx) {
    await ctx.test("original-registered-tool-rejects-missing-message", async () => {
      const result = await window.__matrix.tools.zhi({});
      ctx.check(result.error === "缺少 message 参数", "Original Zhi tool validation differs"); return result;
    }, { kind: "validation" });
  } },
];
