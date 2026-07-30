# Console Styles

Two readonly lookup objects for terminal output: `Ansi` (86 escape sequences — colors, text attributes, cursor control, screen clearing, terminal modes) and `Emoji` (140 named Unicode symbols). They are raw string constants, not a formatting library — you concatenate them yourself. Reach for this when you want colored CLI output or a redrawing progress line without adding `chalk`, `ansi-escapes`, or `figures`.

## Why

Inlining magic strings (`console.log("\x1b[32m✓\x1b[0m done")`) is genuinely fine for two lines and stops being fine at about the tenth.

They are **unreadable and unsearchable** — `\x1b[36m` is cyan and `\x1b[46m` is a cyan *background*, one digit apart, visually identical in a diff, and no editor autocompletes either. They are **easy to get subtly wrong**: `\x1b[1K` erases from line start to cursor, `\x1b[K` from cursor to line end, `\x1b[2K` the whole line — pick wrong and your redraw looks correct until the line gets shorter, then leaves trailing garbage. And **the typo failure mode is silent**: a misspelled property is a compile error, but a mistyped escape is a string the terminal either ignores or interprets as something else (`\x1b[3J` clears scrollback, `\x1b[J` clears from the cursor down). Nothing catches that except running it and looking.

`chalk` solves all of this, but brings its own color-detection logic, a `.level` setting, and a chainable API. This module deliberately does not compete — it is a *dictionary*, not a *formatter*.

`Emoji` exists for the same reason at lower stakes: `Emoji.WARN` survives a copy-paste through a terminal, a review tool, and an editor that renders `⚠️` as a box, and gives you one place to swap the whole glyph vocabulary.

## How it works

### What an ANSI escape sequence is

Every `Ansi` entry except `BELL` starts with `\x1b[` — byte `0x1B` (ESC) plus `[`, forming the **CSI** (Control Sequence Introducer). On reading a CSI the terminal stops treating bytes as text to print and starts treating them as a command. The shape is `CSI parameters final-byte`, where parameters are decimal numbers separated by `;` and the final byte names the command. Parameters are meaningless without it: `1` is "bold" under `m` and "row 1" under `H`.

| Final byte | Command | Used by |
| --- | --- | --- |
| `m` | SGR — Select Graphic Rendition | all colors and text attributes |
| `H` | CUP — Cursor Position | `CURSOR_HOME` |
| `A` `B` `C` `D` | CUU/CUD/CUF/CUB — cursor up/down/forward/back | `CURSOR_UP` … `CURSOR_BACK` |
| `E` `F` | CNL/CPL — cursor next/previous line | `CURSOR_NEXT_LINE`, `CURSOR_PREV_LINE` |
| `J` | ED — Erase in Display | the `CLEAR_SCREEN*` family |
| `K` | EL — Erase in Line | the `CLEAR_LINE*` family |
| `s` `u` | save / restore cursor position | `CURSOR_SAVE`, `CURSOR_RESTORE` |
| `h` `l` | SM / RM — set / reset a mode | `HIDE_CURSOR`, `ALT_SCREEN_*`, `WRAP_*` |

An omitted parameter takes a default: `\x1b[A` is `\x1b[1A` (up one row), `\x1b[J` is `\x1b[0J` (erase from cursor down). That is why `CURSOR_UP` moves exactly one line and there is no way to move three without building `` `\x1b[3A` `` yourself.

Sequences beginning `\x1b[?` are **DEC private modes**, VT100 vendor extensions every modern terminal implements. `h` turns one on and `l` off, which is why they come in pairs: `?25l`/`?25h` for the cursor, `?1049h`/`?1049l` for the alternate screen, `?7h`/`?7l` for line wrap. `BELL` is the odd one out — `\x07` is the raw C0 control character, predating the escape mechanism entirely.

### Why the SGR numbers look the way they do

The parameter space is laid out in blocks, so you can read any code here without a lookup:

| Range | Meaning |
| --- | --- |
| `0` | reset everything |
| `1`–`9` | turn on an attribute (bold, dim, italic, underline, blink, blink-fast, reverse, hidden, strikethrough) |
| `21`–`29` | turn the corresponding attribute *off* — generally `20 + n` |
| `30`–`37` | foreground: black, red, green, yellow, blue, magenta, cyan, white |
| `39` | foreground back to the terminal default |
| `40`–`47` | background, same color order |
| `49` | background back to the terminal default |
| `90`–`97` / `100`–`107` | bright foreground / bright background, same order |

The color order is a 3-bit field — blue=1, green=2, red=4 — so yellow (red+green) is 3 and white is 7. That is the whole derivation of `FG_YELLOW` being `33`.

The `20 + n` reset rule has one exception, and it explains a gap: **`22` resets both bold (`1`) and dim (`2`)**, so there is no "dim off" code and `Ansi` exports `RESET_BOLD` but no `RESET_DIM`. Two more gaps run the same way — `DOUBLE_UNDERLINE` (`21`) is cancelled by `RESET_UNDERLINE` (`24`), and `OVERLINE` (`53`) is cancelled by `55`, which this file does not export at all (use `RESET`).

`38` and `48` are the escape hatches beyond 16 colors, taking a sub-selector: `5` means "one 256-palette index follows", `2` means "three 8-bit channels follow". That derives all four helpers — `` fg256: (n) => `\x1b[38;5;${n}m` ``, `` bgRGB: (r,g,b) => `\x1b[48;2;${r};${g};${b}m` ``.

### Design decisions

**Constants, not a chainable API.** You write `Ansi.FG_RED + Ansi.BOLD + "x" + Ansi.RESET` rather than `chalk.red.bold("x")`. What that costs: *no automatic reset* (forgetting `Ansi.RESET` leaks style into subsequent output); *no nesting repair* (chalk re-opens the enclosing style after an inner one closes — here an inner `RESET` clears the outer color too, because SGR state is a single flat register on the terminal, not a stack); *no capability detection or downgrade* (chalk degrades truecolor → 256 → 16 → nothing; this emits exactly what you asked for, always). What it buys: zero dependencies, zero runtime cost, and the cursor and screen sequences — `chalk` covers SGR only and does no cursor movement or screen clearing at all.

**One object, not one export per constant.** A bundler will not generally drop individual properties from an object literal you index into, so importing `Ansi` for one color pulls all 86 entries — a few kilobytes of short strings, traded for a compact, discoverable, autocompleting namespace.

**The `base` / `Ansi` split.** `ansi-codes.ts` defines a private `base`, spreads it into the exported `Ansi`, and appends five pre-composed log prefixes (`` LOG_SUCCESS: `${base.FG_GREEN}✓${base.RESET}` ``). The split exists purely so those five can reference the codes they are built from. The `LOG_*` values are the **only** self-resetting entries in the module.

**A typing wrinkle worth knowing before editing.** `Ansi` is declared `as const` but `base` is not, so the literal types are already widened by the time `base` is spread. `as const` makes the properties `readonly` but does **not** preserve literal types: `Ansi.RESET` is typed `string`, not `"\x1b[0m"`, while `Emoji.SUCCESS` is typed `"✅"` (a plain literal with its own `as const`). So `typeof Ansi[keyof typeof Ansi]` gives you nothing more specific than `string`. Adding `as const` to `base` fixes it, non-breakingly for consumers who only concatenate. Neither object is `Object.freeze`d at runtime.

**`Emoji` is not strictly emoji.** `DONE` (`✓` U+2713), `CHECK` (`✔` U+2714), `CROSS` (`✗` U+2717), `SKIP` (`⊘` U+2298) and the four `ARROW_*` glyphs are text-presentation characters, chosen deliberately because they render at single-cell width in a monospace terminal, which most true emoji do not.

## API

Both objects come from `console-styles/index.ts`, a pure barrel over `./ansi-codes` and `./emoji`. There are no other exports, no default export, and no functions beyond the four color helpers.

### `Ansi`

86 entries: 82 string constants and 4 functions.

**Cursor movement**

| Name | Value | Effect |
| --- | --- | --- |
| `CURSOR_HOME` | `\x1b[H` | Move to row 1, column 1 |
| `CURSOR_UP` / `CURSOR_DOWN` | `\x1b[A` / `\x1b[B` | Up / down one row, same column |
| `CURSOR_FORWARD` / `CURSOR_BACK` | `\x1b[C` / `\x1b[D` | Right / left one column |
| `CURSOR_NEXT_LINE` / `CURSOR_PREV_LINE` | `\x1b[E` / `\x1b[F` | Down / up one row, to column 1 |
| `CURSOR_SAVE` / `CURSOR_RESTORE` | `\x1b[s` / `\x1b[u` | Save / restore the cursor position |
| `HIDE_CURSOR` / `SHOW_CURSOR` | `\x1b[?25l` / `\x1b[?25h` | Hide / show the cursor |

**Line and screen clearing**

| Name | Value | Effect |
| --- | --- | --- |
| `CLEAR_LINE` | `\r\x1b[K` | Carriage return then erase to end of line — clears the line and parks the cursor at column 1 |
| `CLEAR_LINE_END` | `\x1b[K` | Erase cursor → end of line; cursor unmoved |
| `CLEAR_LINE_START` | `\x1b[1K` | Erase line start → cursor; cursor unmoved |
| `CLEAR_LINE_FULL` | `\x1b[2K` | Erase the whole line; cursor unmoved |
| `CLEAR_SCREEN` | `\x1b[2J` | Erase the whole screen; cursor unmoved |
| `CLEAR_SCREEN_DOWN` | `\x1b[J` | Erase cursor → end of screen |
| `CLEAR_SCREEN_UP` | `\x1b[1J` | Erase start of screen → cursor |
| `CLEAR_SCROLLBACK` | `\x1b[3J` | Erase the scrollback buffer |

`CLEAR_LINE` is the only entry combining two sequences, and is what you want for a redrawing status line.

**Text attributes**

| Name | Value | | Name | Value |
| --- | --- | --- | --- | --- |
| `RESET` | `\x1b[0m` | | `HIDDEN` | `\x1b[8m` |
| `BOLD` | `\x1b[1m` | | `STRIKETHROUGH` | `\x1b[9m` |
| `DIM` | `\x1b[2m` | | `DOUBLE_UNDERLINE` | `\x1b[21m` |
| `ITALIC` | `\x1b[3m` | | `OVERLINE` | `\x1b[53m` |
| `UNDERLINE` | `\x1b[4m` | | | |
| `BLINK` | `\x1b[5m` | | | |
| `BLINK_FAST` | `\x1b[6m` | | | |
| `REVERSE` | `\x1b[7m` | | | |

`RESET` clears all attributes and colors; `HIDDEN` conceals text that still occupies space; `REVERSE` swaps foreground and background.

**Attribute resets**

| Name | Value | Effect |
| --- | --- | --- |
| `RESET_BOLD` | `\x1b[22m` | Normal intensity — cancels **both** `BOLD` and `DIM` |
| `RESET_ITALIC` | `\x1b[23m` | Italic off |
| `RESET_UNDERLINE` | `\x1b[24m` | Underline off — also cancels `DOUBLE_UNDERLINE` |
| `RESET_BLINK` | `\x1b[25m` | Blink off — cancels both `BLINK` and `BLINK_FAST` |
| `RESET_REVERSE` | `\x1b[27m` | Reverse off |
| `RESET_HIDDEN` | `\x1b[28m` | Conceal off |
| `RESET_STRIKETHROUGH` | `\x1b[29m` | Strikethrough off |

There is no `RESET_OVERLINE`; use `RESET`.

**Colors** — foreground `FG_*` and background `BG_*` share the same eight color names plus a default:

| Name | FG | BG | | Bright name | FG | BG |
| --- | --- | --- | --- | --- | --- | --- |
| `BLACK` | `30` | `40` | | `GRAY` | `90` | `100` |
| `RED` | `31` | `41` | | `BRIGHT_RED` | `91` | `101` |
| `GREEN` | `32` | `42` | | `BRIGHT_GREEN` | `92` | `102` |
| `YELLOW` | `33` | `43` | | `BRIGHT_YELLOW` | `93` | `103` |
| `BLUE` | `34` | `44` | | `BRIGHT_BLUE` | `94` | `104` |
| `MAGENTA` | `35` | `45` | | `BRIGHT_MAGENTA` | `95` | `105` |
| `CYAN` | `36` | `46` | | `BRIGHT_CYAN` | `96` | `106` |
| `WHITE` | `37` | `47` | | `BRIGHT_WHITE` | `97` | `107` |
| `DEFAULT` | `39` | `49` | | | | |

Each is the full sequence — `FG_RED` is `\x1b[31m`, `BG_BRIGHT_CYAN` is `\x1b[106m`. `FG_GRAY` occupies the bright-black slot; there is no `FG_BRIGHT_BLACK` alias.

**Color helpers** — none validate or clamp, and none throw.

| Signature | Returns |
| --- | --- |
| `Ansi.fg256(n: number): string` | `` `\x1b[38;5;${n}m` `` — `n` indexes the 256-color palette: `0`–`7` basic, `8`–`15` bright, `16`–`231` a 6×6×6 RGB cube, `232`–`255` a 24-step grayscale ramp |
| `Ansi.bg256(n: number): string` | `` `\x1b[48;5;${n}m` `` — as above, background |
| `Ansi.fgRGB(r, g, b: number): string` | `` `\x1b[38;2;${r};${g};${b}m` `` — channels `0`–`255`, requires a truecolor terminal |
| `Ansi.bgRGB(r, g, b: number): string` | `` `\x1b[48;2;${r};${g};${b}m` `` — as above, background |

**Terminal modes and bell**

| Name | Value | Effect |
| --- | --- | --- |
| `ALT_SCREEN_ON` / `ALT_SCREEN_OFF` | `\x1b[?1049h` / `\x1b[?1049l` | Switch to / from the alternate screen buffer (what `vim` and `less` use); switching back restores the previous contents |
| `WRAP_ON` / `WRAP_OFF` | `\x1b[?7h` / `\x1b[?7l` | Wrap past the right margin / truncate at it |
| `BELL` | `\x07` | The BEL control character — audible beep or visual flash, per terminal config |

**Log prefixes** — the only pre-composed values, each `color + glyph + RESET`, self-contained and safe to embed anywhere without leaking style.

| Name | Value | Renders as |
| --- | --- | --- |
| `LOG_SUCCESS` | `` `${FG_GREEN}✓${RESET}` `` | green `✓` |
| `LOG_ERROR` | `` `${FG_RED}✕${RESET}` `` | red `✕` |
| `LOG_WARN` | `` `${FG_YELLOW}⚠${RESET}` `` | yellow `⚠` |
| `LOG_INFO` | `` `${FG_BLUE}ℹ${RESET}` `` | blue `ℹ` |
| `LOG_DEBUG` | `` `${FG_MAGENTA}⚙${RESET}` `` | magenta `⚙` |

### `Emoji`

140 named Unicode strings, one flat object grouped only by source comments. Unlike `Ansi`, the values keep their literal types.

| Group | Names |
| --- | --- |
| Status & Feedback | `SUCCESS` ✅, `ERROR` ❌, `WARN` ⚠️, `INFO` ℹ️, `DEBUG` 🐛, `LOADING` ⏳, `HOURGLASS` ⌛, `DONE` ✓, `SKIP` ⊘, `QUESTION` ❓, `EXCLAIM` ❗, `NEW` 🆕, `OK` 🆗 |
| Actions & Arrows | `ARROW_RIGHT` →, `ARROW_LEFT` ←, `ARROW_UP` ↑, `ARROW_DOWN` ↓, `CHECK` ✔, `CROSS` ✗, `REFRESH` 🔄, `SYNC` 🔃, `RETRY` ↩️ |
| Media Controls | `PLAY` ▶️, `PAUSE` ⏸, `STOP` ⏹, `RECORD` ⏺, `FAST_FORWARD` ⏩, `REWIND` ⏪, `EJECT` ⏏️ |
| Trend / Data | `UP_TREND` 📈, `DOWN_TREND` 📉, `CHART` 📊, `STAR` ⭐, `SPARKLES` ✨, `FIRE` 🔥, `HEART` ❤️, `ROCKET` 🚀, `GEAR` ⚙️, `ZAP` ⚡, `BOOM` 💥, `TARGET` 🎯, `TROPHY` 🏆, `MEDAL` 🏅 |
| File / Data / Storage | `FILE` 📄, `FILES` 🗂️, `FOLDER` 📁, `FOLDER_OPEN` 📂, `TRASH` 🗑️, `SAVE` 💾, `DATABASE` 🗄️, `ARCHIVE` 📦, `CLIPBOARD` 📋, `PIN` 📌, `PAPERCLIP` 📎, `BOOKMARK` 🔖 |
| Security | `LOCK` 🔒, `UNLOCK` 🔓, `KEY` 🔑, `SHIELD` 🛡️, `FINGERPRINT` 👆, `EYE` 👁️ |
| Development | `BUG` 🐛, `LINK` 🔗, `CHAIN_BREAK` ⛓️‍💥, `CODE` 💻, `TERMINAL` 🖥️, `PACKAGE` 📦, `WRENCH` 🔧, `HAMMER` 🔨, `TOOLS` 🛠️, `TEST_TUBE` 🧪, `MAGNIFYING_GLASS` 🔍, `BRANCH` 🌿, `MERGE` 🔀, `TAG` 🏷️ |
| Network / Cloud | `GLOBE` 🌐, `CLOUD` ☁️, `SATELLITE` 📡, `SIGNAL` 📶, `WIFI` 📶, `PLUG` 🔌, `BATTERY` 🔋, `ELECTRIC` 🔌 |
| Communication | `MAIL` 📧, `INBOX` 📥, `OUTBOX` 📤, `BELL` 🔔, `BELL_MUTE` 🔕, `SPEECH` 💬, `MEGAPHONE` 📢, `PHONE` 📞 |
| Time | `CLOCK` 🕐, `ALARM` ⏰, `STOPWATCH` ⏱️, `TIMER` ⏲️, `CALENDAR` 📅, `DATE` 📆 |
| People / Reactions | `THUMBS_UP` 👍, `THUMBS_DOWN` 👎, `CLAP` 👏, `WAVE` 👋, `RAISED_HANDS` 🙌, `PRAY` 🙏, `MUSCLE` 💪, `BRAIN` 🧠, `EYES` 👀, `THINKING` 🤔, `SHRUG` 🤷, `FACEPALM` 🤦 |
| Weather / Nature | `SUN` ☀️, `MOON` 🌙, `STAR_NIGHT` 🌟, `RAIN` 🌧️, `SNOW` ❄️, `STORM` ⛈️, `RAINBOW` 🌈, `LEAF` 🍃, `TREE` 🌳, `SEEDLING` 🌱 |
| Numbers / Symbols | `HUNDRED` 💯, `INFINITY` ♾️, `PLUS` ➕, `MINUS` ➖, `MULTIPLY` ✖️, `DIVIDE` ➗, `RECYCLE` ♻️ |
| Misc | `PARTY` 🎉, `CONFETTI` 🎊, `GIFT` 🎁, `FLAG` 🚩, `CHECKERED_FLAG` 🏁, `MAP` 🗺️, `COMPASS` 🧭, `LIGHT_BULB` 💡, `MAGIC` 🪄, `CRYSTAL_BALL` 🔮, `ALIEN` 👽, `ROBOT` 🤖, `GHOST` 👻, `SKULL` 💀 |

Four pairs are aliases holding identical values: `DEBUG`/`BUG` (🐛), `ARCHIVE`/`PACKAGE` (📦), `SIGNAL`/`WIFI` (📶), `PLUG`/`ELECTRIC` (🔌).

## Usage

```ts
import { Ansi, Emoji } from "@isel-jao/ts-lib";

console.log(`${Ansi.LOG_SUCCESS} build finished in 1.2s`);

// Anything outside the LOG_* family needs an explicit reset.
console.log(`${Ansi.FG_YELLOW}${Ansi.BOLD}deprecated${Ansi.RESET} — use v2 instead`);

// Emoji as a status vocabulary.
const label = { pass: Emoji.SUCCESS, fail: Emoji.ERROR, skip: Emoji.SKIP } as const;
console.log(`${label[result.status]} ${result.name}`);

// Runtime colors: truecolor, and the 232-255 grayscale ramp for dimming.
const heat = (pct: number) =>
  `${Ansi.fgRGB(Math.round(255 * pct), Math.round(255 * (1 - pct)), 0)}${(pct * 100).toFixed(0)}%${Ansi.RESET}`;
const muted = (s: string) => `${Ansi.fg256(244)}${s}${Ansi.RESET}`;
```

**Guarding on TTY and `NO_COLOR`.** The module does no environment detection at all, so this is yours to write:

```ts
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

function style(s: string, ...codes: string[]): string {
  return useColor ? `${codes.join("")}${s}${Ansi.RESET}` : s;
}

console.log(style("FAIL", Ansi.FG_RED, Ansi.BOLD), "connection refused");
// piped to a file: "FAIL connection refused", no escape bytes
```

**A redrawing progress line** — `CLEAR_LINE` plus `HIDE_CURSOR`, with the cursor restored in a `finally` so a thrown error or a `Ctrl-C` handler cannot leave the terminal without one:

```ts
async function withProgress(total: number, work: (i: number) => Promise<void>) {
  const tty = process.stdout.isTTY === true;
  if (tty) process.stdout.write(Ansi.HIDE_CURSOR);
  try {
    for (let i = 1; i <= total; i++) {
      await work(i);
      if (!tty) continue;
      const filled = "█".repeat(Math.round((i / total) * 20));
      const empty = "░".repeat(20 - filled.length);
      process.stdout.write(
        `${Ansi.CLEAR_LINE}${Ansi.FG_CYAN}${filled}${Ansi.FG_GRAY}${empty}${Ansi.RESET} ${i}/${total}`,
      );
    }
  } finally {
    if (tty) process.stdout.write(`${Ansi.CLEAR_LINE}${Ansi.SHOW_CURSOR}`);
  }
}
```

The `\r` in `CLEAR_LINE` returns to column 1 and `\x1b[K` erases the old, possibly longer, text — `\r` alone would leave the tail of a longer previous frame visible.

**A full-screen view on the alternate buffer:**

```ts
function fullScreen(render: () => string) {
  process.stdout.write(Ansi.ALT_SCREEN_ON + Ansi.HIDE_CURSOR);
  try {
    process.stdout.write(Ansi.CLEAR_SCREEN + Ansi.CURSOR_HOME + render());
  } finally {
    process.stdout.write(Ansi.SHOW_CURSOR + Ansi.ALT_SCREEN_OFF);
  }
}
```

`CLEAR_SCREEN` erases without moving the cursor, which is why `CURSOR_HOME` follows it — getting this backwards is the classic "why is my output starting halfway down the screen" bug.

## Edge cases

### `Ansi`

| Case | Behavior |
| --- | --- |
| **Missing `RESET`** | SGR state is terminal-global and persists across writes *and across process boundaries* — `write(Ansi.FG_RED + "x")` leaves the shell red after your program exits, until something emits a reset. The five `LOG_*` values are the only self-resetting entries. |
| **Nesting** | No style stack. An inner `RESET` clears the enclosing style too: in `` `${Ansi.FG_RED}a${Ansi.BOLD}b${Ansi.RESET}c` ``, `c` is unstyled, not red. To end just the bold, use `RESET_BOLD`. |
| **Non-TTY output** | **No TTY detection, no `NO_COLOR`/`FORCE_COLOR` handling whatsoever.** Redirected to a file or a CI log collector, every sequence is written verbatim and shows as `ESC[31m` / `^[[31m` / `\033[31m` noise. Guard on `process.stdout.isTTY` yourself. This is the single biggest gap versus `chalk`. |
| **No strip helper** | Nothing removes ANSI codes from a string. Build plain and styled forms separately, or write your own `replace(/\x1b\[[0-9;]*m/g, "")`. |
| **`.length` ≠ display width** | `` (`${Ansi.FG_RED}x${Ansi.RESET}`).length `` is `10`, not `1`, so `padStart`/`padEnd` and any table layout break on styled strings. Pad first, style second. |
| **`fg256`/`bg256` out of range** | No validation. `fg256(999)` returns a sequence most terminals ignore, leaving the previous color. Fractional and negative values interpolate verbatim (`fg256(1.5)` → `"\x1b[38;5;1.5m"`), and `NaN` yields `"\x1b[38;5;NaNm"` — malformed either way. Clamp and round before calling. |
| **`fgRGB`/`bgRGB` without truecolor** | Typically ignored rather than approximated, so text renders in whatever color was already active. No automatic downgrade to the 256 palette. |
| **`DOUBLE_UNDERLINE` (`21`)** | ECMA-48 assigns `21` to double underline, but several terminals historically implemented it as "bold off". Verify on your target before relying on it. |
| **`BLINK` / `BLINK_FAST`** | Widely disabled or ignored by modern emulators; `BLINK_FAST` (`6`) has even thinner support than `BLINK` (`5`). |
| **`CURSOR_SAVE`/`CURSOR_RESTORE`** | A single slot, not a stack — a second save overwrites the first, so they do not nest. |
| **No parameterized movement** | Every cursor sequence is the no-parameter form and moves exactly one cell or line. To move `n`, build `` `\x1b[${n}A` `` yourself. |
| **`ALT_SCREEN_ON` without `OFF`** | Leaves the user's shell on the alternate buffer after exit, hiding their scrollback. Always pair in a `finally`, and consider a `SIGINT` handler. |
| **`HIDE_CURSOR` without `SHOW_CURSOR`** | Same failure mode — an invisible cursor, usually needing `reset` or `tput cnorm` to recover. |
| **Windows** | Modern Windows Terminal and PowerShell handle these. Legacy `conhost` needs virtual-terminal processing enabled by the host process; where it is not, sequences print as literal text. Nothing here enables it. |
| **Value types** | `Ansi` properties are `readonly` but typed `string`, not literals, because `base` is spread in without its own `as const`. `Emoji` properties *do* carry literal types. Neither object is frozen at runtime. |

### `Emoji`

| Case | Behavior |
| --- | --- |
| **Duplicate values** | The four alias pairs hold byte-identical strings, so `Emoji.SIGNAL === Emoji.WIFI` is `true`. |
| **Variation selectors** | 27 entries carry U+FE0F (VS16) to force emoji presentation — `WARN` ⚠️, `INFO` ℹ️, `GEAR` ⚙️, `HEART` ❤️, `SUN` ☀️ and others. The rest do not, so `PAUSE` ⏸, `STOP` ⏹ and `RECORD` ⏺ may render as monochrome text glyphs depending on the font. |
| **`CHAIN_BREAK` is a ZWJ sequence** | `⛓️‍💥` is U+26D3 U+FE0F U+200D U+1F4A5 — 4 code points, `.length === 5` in UTF-16. Terminals without support render it as two separate glyphs. |
| **`.length` ≠ display width** | Most entries are astral-plane characters with `.length === 2`, many rendering two cells wide; the text-presentation ones (`DONE`, `CHECK`, `CROSS`, `SKIP`, the arrows) render one cell wide with `.length === 1`. Column alignment across mixed entries needs a real width table — neither `.length` nor `[...s].length` will do it. |
| **Font dependence** | Rendering is entirely up to the terminal's font stack; a missing glyph appears as a tofu box, with no fallback mechanism. `DONE`, `CHECK`, `CROSS`, `SKIP` and the `ARROW_*` set are the safest for wide compatibility. |
| **Keys are not grouped at runtime** | Keys are `SCREAMING_SNAKE_CASE` throughout, but the grouping comments carry no runtime meaning — `Emoji` is one flat object. |
