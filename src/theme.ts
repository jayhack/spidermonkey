// Wave Kit dark tokens: https://wave-kit.dev (the deployed global stylesheet).
// Keep semantic roles here so the terminal uses the same palette as the site.
export const waveColors = {
  canvas: '#000000',       // wave-canvas / wave-ink
  heading: '#fafafa',      // wave-heading
  body: '#d4d4d4',         // wave-body
  muted: '#a3a3a3',        // wave-muted
  subtle: '#737373',       // wave-subtle
  border: '#3b3b3b',       // wave-border-strong (#ffffff3b) on wave-canvas
  signal: '#2090c8',       // wave-blue-vivid
  sky: '#7dd3fc',          // wave-link-sky / wave-blue-light
  success: '#4dabd9',      // wave-blue-300; checkmarks and labels convey success
  accent: '#f97316',       // wave-orange
  warning: '#fbbf24',      // wave-amber
  danger: '#ff3b30',       // wave-red-hot
} as const;

function color(hex: string, background = false): string {
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return `\x1b[${background ? 48 : 38};2;${rgb.join(';')}m`;
}

const canvas = color(waveColors.canvas, true);
const body = color(waveColors.body);

export const terminalTheme = {
  // Internal resets restore the dashboard canvas; Dashboard.restore resets the
  // terminal's own colors before leaving the alternate screen.
  reset: '\x1b[0m' + canvas + body,
  canvas,
  body,
  bright: '\x1b[1m' + color(waveColors.heading),
  dim: color(waveColors.subtle),
  muted: color(waveColors.muted),
  border: color(waveColors.border),
  executive: color(waveColors.sky),
  signal: color(waveColors.signal),
  success: color(waveColors.success),
  accent: color(waveColors.accent),
  warning: color(waveColors.warning),
  danger: color(waveColors.danger),
} as const;
