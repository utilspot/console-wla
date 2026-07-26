import type { ITheme } from '@xterm/xterm';

/** Kept in sync with the CSS custom properties in style.css. */
export const THEME: ITheme = {
  background: '#0b0f14',
  foreground: '#d6dee9',
  cursor: '#67e8c3',
  cursorAccent: '#0b0f14',
  selectionBackground: '#2a4a5f',
  black: '#0b0f14',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#e3b341',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#67e8c3',
  white: '#c9d1d9',
  brightBlack: '#4c5766',
  brightRed: '#ffa198',
  brightGreen: '#a5f3ae',
  brightYellow: '#f2cc60',
  brightBlue: '#a5d6ff',
  brightMagenta: '#e2c5ff',
  brightCyan: '#9df0dc',
  brightWhite: '#f0f6fc',
};

export const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
