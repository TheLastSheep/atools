const LIGHT_FOREGROUND = "#ffffff";
const DARK_FOREGROUND = "#07111f";

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map(part => part + part).join("") : match[1];
  return [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

function luminance([red, green, blue]: [number, number, number]): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

const DARK_LUMINANCE = luminance(parseHexColor(DARK_FOREGROUND)!);

/** Chooses the light or near-black foreground with the higher WCAG contrast against the applied accent. */
export function accentForegroundForAccent(accent: string): string {
  const rgb = parseHexColor(accent);
  if (!rgb) return DARK_FOREGROUND;
  const lightContrast = 1.05 / (luminance(rgb) + 0.05);
  const darkContrast = (luminance(rgb) + 0.05) / (DARK_LUMINANCE + 0.05);
  return lightContrast >= darkContrast ? LIGHT_FOREGROUND : DARK_FOREGROUND;
}
