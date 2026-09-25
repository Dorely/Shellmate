import type { ITheme } from '@xterm/xterm';
import type { ThemeName } from '../shared/types';

export type { ThemeName } from '../shared/types';
const key = 'shellmate-theme';

export function readTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'graphite' || saved === 'light' || saved === 'forest') return saved;
  } catch { /* Storage may be unavailable in a restricted renderer. */ }
  return 'graphite';
}

export function setTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(key, theme); } catch { /* Keep the current session usable. */ }
}

export const terminalThemes: Record<ThemeName, ITheme> = {
  graphite: {
    background: '#15191f', foreground: '#e4e8ef', cursor: '#89b4fa', selectionBackground: '#334767',
    black: '#303641', red: '#f08b8b', green: '#9dd8ad', yellow: '#e5c685', blue: '#89b4fa', magenta: '#c8a4ed', cyan: '#8ed1db', white: '#d8deea',
    brightBlack: '#687282', brightRed: '#ffaaaa', brightGreen: '#b6e5c1', brightYellow: '#f2dba8', brightBlue: '#afd0ff', brightMagenta: '#dfbaff', brightCyan: '#b0e7ed', brightWhite: '#ffffff'
  },
  light: {
    background: '#ffffff', foreground: '#243044', cursor: '#255cc0', selectionBackground: '#c9daf6',
    black: '#283446', red: '#b33338', green: '#187446', yellow: '#8f6211', blue: '#255cc0', magenta: '#8a48a8', cyan: '#08798b', white: '#e5e9ef',
    brightBlack: '#627083', brightRed: '#c34c4f', brightGreen: '#238b55', brightYellow: '#a6731c', brightBlue: '#3f72cb', brightMagenta: '#a05bb7', brightCyan: '#168c9b', brightWhite: '#ffffff'
  },
  forest: {
    background: '#151a19', foreground: '#dbe8df', cursor: '#9acbae', selectionBackground: '#315440',
    black: '#26312b', red: '#ee9f9f', green: '#a3d3b6', yellow: '#e2ce9a', blue: '#91b9db', magenta: '#cba9d9', cyan: '#9ccfd0', white: '#dbe8df',
    brightBlack: '#6a8071', brightRed: '#f2aaaa', brightGreen: '#b7dfc7', brightYellow: '#f0dba9', brightBlue: '#afcfea', brightMagenta: '#dabce5', brightCyan: '#b6e3e3', brightWhite: '#ffffff'
  }
};

setTheme(readTheme());
