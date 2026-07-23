const base = {
  // ===== Cursor Movement =====
  CURSOR_HOME: "\x1b[H",
  CURSOR_UP: "\x1b[A",
  CURSOR_DOWN: "\x1b[B",
  CURSOR_FORWARD: "\x1b[C",
  CURSOR_BACK: "\x1b[D",
  CURSOR_NEXT_LINE: "\x1b[E",
  CURSOR_PREV_LINE: "\x1b[F",
  CURSOR_SAVE: "\x1b[s",
  CURSOR_RESTORE: "\x1b[u",
  HIDE_CURSOR: "\x1b[?25l",
  SHOW_CURSOR: "\x1b[?25h",

  // ===== Line / Screen Clearing =====
  CLEAR_LINE: "\r\x1b[K",
  CLEAR_LINE_END: "\x1b[K",
  CLEAR_LINE_START: "\x1b[1K",
  CLEAR_LINE_FULL: "\x1b[2K",
  CLEAR_SCREEN: "\x1b[2J",
  CLEAR_SCREEN_DOWN: "\x1b[J",
  CLEAR_SCREEN_UP: "\x1b[1J",
  CLEAR_SCROLLBACK: "\x1b[3J",

  // ===== Text Styles =====
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  UNDERLINE: "\x1b[4m",
  BLINK: "\x1b[5m",
  BLINK_FAST: "\x1b[6m",
  REVERSE: "\x1b[7m",
  HIDDEN: "\x1b[8m",
  STRIKETHROUGH: "\x1b[9m",
  DOUBLE_UNDERLINE: "\x1b[21m",
  OVERLINE: "\x1b[53m",

  // ===== Reset Individual Styles =====
  RESET_BOLD: "\x1b[22m",
  RESET_ITALIC: "\x1b[23m",
  RESET_UNDERLINE: "\x1b[24m",
  RESET_BLINK: "\x1b[25m",
  RESET_REVERSE: "\x1b[27m",
  RESET_HIDDEN: "\x1b[28m",
  RESET_STRIKETHROUGH: "\x1b[29m",

  // ===== Foreground Colors =====
  FG_BLACK: "\x1b[30m",
  FG_RED: "\x1b[31m",
  FG_GREEN: "\x1b[32m",
  FG_YELLOW: "\x1b[33m",
  FG_BLUE: "\x1b[34m",
  FG_MAGENTA: "\x1b[35m",
  FG_CYAN: "\x1b[36m",
  FG_WHITE: "\x1b[37m",
  FG_DEFAULT: "\x1b[39m",

  // ===== Bright Foreground Colors =====
  FG_GRAY: "\x1b[90m",
  FG_BRIGHT_RED: "\x1b[91m",
  FG_BRIGHT_GREEN: "\x1b[92m",
  FG_BRIGHT_YELLOW: "\x1b[93m",
  FG_BRIGHT_BLUE: "\x1b[94m",
  FG_BRIGHT_MAGENTA: "\x1b[95m",
  FG_BRIGHT_CYAN: "\x1b[96m",
  FG_BRIGHT_WHITE: "\x1b[97m",

  // ===== Background Colors =====
  BG_BLACK: "\x1b[40m",
  BG_RED: "\x1b[41m",
  BG_GREEN: "\x1b[42m",
  BG_YELLOW: "\x1b[43m",
  BG_BLUE: "\x1b[44m",
  BG_MAGENTA: "\x1b[45m",
  BG_CYAN: "\x1b[46m",
  BG_WHITE: "\x1b[47m",
  BG_DEFAULT: "\x1b[49m",

  // ===== Bright Background Colors =====
  BG_GRAY: "\x1b[100m",
  BG_BRIGHT_RED: "\x1b[101m",
  BG_BRIGHT_GREEN: "\x1b[102m",
  BG_BRIGHT_YELLOW: "\x1b[103m",
  BG_BRIGHT_BLUE: "\x1b[104m",
  BG_BRIGHT_MAGENTA: "\x1b[105m",
  BG_BRIGHT_CYAN: "\x1b[106m",
  BG_BRIGHT_WHITE: "\x1b[107m",

  // ===== 256-Color / RGB Helpers =====
  fg256: (n: number) => `\x1b[38;5;${n}m`,
  bg256: (n: number) => `\x1b[48;5;${n}m`,
  fgRGB: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
  bgRGB: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,

  // ===== Terminal Modes =====
  ALT_SCREEN_ON: "\x1b[?1049h",
  ALT_SCREEN_OFF: "\x1b[?1049l",
  WRAP_ON: "\x1b[?7h",
  WRAP_OFF: "\x1b[?7l",

  // ===== Bell =====
  BELL: "\x07",
};

export const Ansi = {
  ...base,

  // ===== Log Prefixes =====
  LOG_SUCCESS: `${base.FG_GREEN}✓${base.RESET}`,
  LOG_ERROR: `${base.FG_RED}✕${base.RESET}`,
  LOG_WARN: `${base.FG_YELLOW}⚠${base.RESET}`,
  LOG_INFO: `${base.FG_BLUE}ℹ${base.RESET}`,
  LOG_DEBUG: `${base.FG_MAGENTA}⚙${base.RESET}`,
} as const;
