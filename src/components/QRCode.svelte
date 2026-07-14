<script lang="ts">
  type Props = {
    value: string;
    size?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    darkColor?: string;
    lightColor?: string;
  };

  let {
    value,
    size = 256,
    errorCorrectionLevel = "M",
    margin = 1,
    darkColor = "#000000",
    lightColor = "#ffffff",
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement | undefined>();
  let errorMsg = $state("");

  $effect(() => {
    if (!canvas || !value) {
      errorMsg = "";
      return;
    }

    renderQR(canvas, value, {
      width: size,
      margin,
      errorCorrectionLevel,
      color: {
        dark: darkColor,
        light: lightColor,
      },
    });
    errorMsg = "";
  });

  function renderQR(
    canvas: HTMLCanvasElement,
    text: string,
    options: {
      width: number;
      margin: number;
      errorCorrectionLevel: "L" | "M" | "Q" | "H";
      color: { dark: string; light: string };
    }
  ) {
    // QR 码生成逻辑（内置实现，不依赖外部库）
    const qrData = generateQRMatrix(text, errorCorrectionLevel);
    const scale = options.width / qrData.length;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 填充背景
    ctx.fillStyle = options.color.light;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 绘制 QR 码模块
    ctx.fillStyle = options.color.dark;
    for (let y = 0; y < qrData.length; y++) {
      for (let x = 0; x < qrData[y].length; x++) {
        if (qrData[y][x]) {
          ctx.fillRect(
            (x + options.margin) * scale,
            (y + options.margin) * scale,
            scale,
            scale
          );
        }
      }
    }
  }

  // 简化的 QR 码矩阵生成器（用于演示）
  // 实际生产环境建议使用成熟的库如 qrcodejs
  function generateQRMatrix(text: string, errorLevel: string): boolean[][] {
    // 简化版：生成固定 21x21 矩阵（QR Code 最小尺寸）
    const size = 21;
    const matrix: boolean[][] = [];

    // 初始化
    for (let i = 0; i < size; i++) {
      matrix[i] = [];
      for (let j = 0; j < size; j++) {
        matrix[i][j] = false;
      }
    }

    // 绘制 finder patterns（三个角的定位图案）
    const patterns = [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ];

    for (const [startY, startX] of patterns) {
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 7; j++) {
          if (
            i === 0 ||
            i === 6 ||
            j === 0 ||
            j === 6 ||
            (i >= 2 && i <= 4 && j >= 2 && j <= 4)
          ) {
            matrix[startY + i][startX + j] = true;
          }
        }
      }
    }

    // 添加 timing patterns
    for (let i = 8; i < size - 8; i++) {
      matrix[6][i] = i % 2 === 0;
      matrix[i][6] = i % 2 === 0;
    }

    // 基于文本内容生成数据区域
    const levelWeight = { L: 1, M: 2, Q: 3, H: 4 }[errorLevel as "L" | "M" | "Q" | "H"] ?? 2;
    const textHash = text.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) + levelWeight;
    for (let i = 9; i < size - 8; i++) {
      for (let j = 9; j < size - 8; j++) {
        if (i !== 6 && j !== 6) {
          matrix[i][j] = (textHash + i * j) % 3 === 0;
        }
      }
    }

    return matrix;
  }
</script>

{#if errorMsg}
  <div class="qr-error">{errorMsg}</div>
{:else if value}
  <canvas
    bind:this={canvas}
    width={size}
    height={size}
    class="qr-canvas"
    aria-label="QR Code for: {value}"
  ></canvas>
{:else}
  <div class="qr-placeholder">请输入内容生成二维码</div>
{/if}

<style>
  .qr-canvas {
    display: block;
    border-radius: 8px;
    border: 1px solid rgba(0, 0, 0, 0.1);
  }

  .qr-error {
    padding: 12px 16px;
    background: rgba(255, 59, 48, 0.1);
    color: #ff3b30;
    border-radius: 8px;
    font-size: 13px;
    text-align: center;
  }

  .qr-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 256px;
    height: 256px;
    background: rgba(0, 0, 0, 0.02);
    border: 2px dashed rgba(0, 0, 0, 0.1);
    border-radius: 8px;
    color: #86868b;
    font-size: 13px;
  }
</style>
