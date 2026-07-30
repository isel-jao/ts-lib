# Console Styles

Two frozen lookup objects for terminal output: `Ansi` (86 ANSI escape sequences — colors, text attributes, cursor control, screen clearing, terminal modes) and `Emoji` (140 named Unicode symbols). They are raw string constants, not a formatting library — you concatenate them yourself. Reach for this when you want colored CLI output or a redrawing progress line without adding `chalk`, `ansi-escapes`, or `figures` as dependencies.

## Why

The naive version is a handful of magic strings inlined at the call site:

```ts
console.log("\x1b[32m✓\x1b[0m build complete");
console.log("\x1b[31mERR\x1b[0m " + message);
```

This works, and for two lines it is genuinely fine. It stops being fine at about the tenth line:

- **They are unreadable and unsearchable.** `\x1b[36m` is cyan and `\x1b[46m` is a cyan *background*. One digit apart, visually identical in a diff, and no editor will autocomplete either. `Ansi.FG_CYAN` and `Ansi.BG_CYAN` are both obvious.
- **They are easy to get subtly wrong.** `\x1b[1K` erases from the line start to the cursor; `\x1b[K` erases from the cursor to the line end; `\x1b[2K` erases the whole line but leaves the cursor where it was. Getting the wrong one produces a redraw that looks correct until the line gets shorter, then leaves trailing garbage. Nobody memorizes this correctly; everyone re-reads the spec, and then re-reads it again six months later.
- **The typo failure mode is silent.** A misspelled property name is a compile error. A mistyped escape sequence is a string the terminal either ignores or, worse, interprets as something else. `\x1b[3J` clears the scrollback buffer; `\x1b[J` clears from the cursor down. There is no test that catches `3` vs nothing except running it and looking.

The alternative — `chalk` — solves all of this and more, but it is a dependency with its own color-detection logic, a `.level` setting, and a chainable API surface. This module deliberately does not compete with that. It is a *dictionary*, not a *formatter*. See [How it works](#how-it-works) for what that trades away.

The `Emoji` object exists for the same reason at a lower stakes level: `Emoji.WARN` survives a copy-paste through a terminal, a code review tool, and an editor that renders `⚠️` as a box, whereas the literal character may not. It also gives you one place to swap the whole glyph vocabulary.

## How it works

### What an ANSI escape sequence actually is

Every entry in `Ansi` except `BELL` starts with `\x1b[` — the byte `0x1B` (ESC) followed by `[`. Together these form the **CSI**, the Control Sequence Introducer. When a terminal emulator reads a CSI in the byte stream it stops treating the following bytes as text to print and starts treating them as a command.

The general shape is:

```
CSI  parameters  final-byte
\x1b[    1;31         m
```

The **parameters** are decimal numbers separated by `;`. The **final byte** names the command. The parameters are meaningless without it — `1` means "bold" under `m` and "row 1" under `H`.

The final bytes used in this file:

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

Where a parameter is omitted the terminal substitutes a default. `\x1b[A` is `\x1b[1A` — move up one row. `\x1b[J` is `\x1b[0J` — erase from the cursor downward. This is why `CURSOR_UP` moves exactly one line and there is no way to move three; you would have to build `\x1b[3A` yourself.

Sequences beginning `\x1b[?` are **DEC private modes** — vendor extensions from the VT100 that every modern terminal implements anyway. `h` turns one on, `l` turns it off, which is why they always come in pairs: `\x1b[?25l` / `\x1b[?25h` for the cursor, `\x1b[?1049h` / `\x1b[?1049l` for the alternate screen, `\x1b[?7h` / `\x1b[?7l` for line wrap.

`BELL` is the odd one out: `\x07` is the raw C0 control character BEL, no ESC and no CSI. It predates the escape-sequence mechanism entirely.

### Why the SGR numbers look the way they do

The SGR parameter space is not arbitrary; it is laid out in blocks, and knowing the layout means you can read any code in this file without a lookup table:

| Range | Meaning |
| --- | --- |
| `0` | reset everything |
| `1`–`9` | turn on a text attribute (bold, dim, italic, underline, blink, blink-fast, reverse, hidden, strikethrough) |
| `21`–`29` | turn the corresponding attribute *off* — generally `20 + n` |
| `30`–`37` | foreground, in the fixed order black, red, green, yellow, blue, magenta, cyan, white |
| `39` | foreground back to the terminal default |
| `40`–`47` | background, same color order |
| `49` | background back to the terminal default |
| `90`–`97` | bright foreground, same color order |
| `100`–`107` | bright background, same color order |

The color order is fixed by the standard and is really a 3-bit field: blue=1, green=2, red=4, so yellow (red+green) is 3 and white is 7. That is why `FG_YELLOW` is `33` and not something arbitrary.

The `20 + n` reset rule has one exception, and it explains a gap in this file: **`22` resets both bold (`1`) and dim (`2`)**. There is no separate code for "dim off", which is why `Ansi` exports `RESET_BOLD` but no `RESET_DIM`. Two other gaps follow the same logic in reverse — `DOUBLE_UNDERLINE` (`21`) is cancelled by `RESET_UNDERLINE` (`24`), and `OVERLINE` (`53`) is cancelled by `55`, which this file does not export at all. Use `RESET` to clear an overline.

`38` and `48` are the escape hatches for foreground and background beyond 16 colors. They take a sub-selector as their next parameter: `5` means "one 256-palette index follows", `2` means "three 8-bit channels follow". That is the entire derivation of the four helper functions:

```ts
fg256: (n: number) => `\x1b[38;5;${n}m`
bgRGB: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`
```

### Key design decisions

**Constants, not a chainable API.** `chalk.red.bold("x")` returns a correctly-wrapped string. `Ansi.FG_RED + Ansi.BOLD + "x" + Ansi.RESET` is what you write here. What you give up by choosing the second:

- *No automatic reset.* chalk closes every style it opens. Here, forgetting `Ansi.RESET` leaks the style into every subsequent line of output until something else resets it (see [Edge cases](#edge-cases)).
- *No nesting repair.* chalk tracks the enclosing style and re-opens it after an inner one closes, so `chalk.red("a" + chalk.bold("b") + "c")` leaves `c` red. Here, the inner `Ansi.RESET` clears the outer red too, because SGR state is a single flat register on the terminal, not a stack.
- *No capability detection or downgrade.* chalk probes the environment and silently degrades truecolor → 256 → 16 → nothing. This module emits exactly what you asked for, always.

What you get in exchange: zero dependencies, zero runtime cost, and access to the cursor and screen sequences — `chalk` covers SGR only and does not do cursor movement or screen clearing at all.

**One object per file, not one export per constant.** `Ansi` and `Emoji` are single objects. A bundler will not, in general, drop individual properties from an object literal that you import and index into dynamically, so importing `Ansi` for one color pulls in all 86 entries. Total payload is a few kilobytes of short strings, which is the trade that was accepted for a compact, discoverable, autocompleting namespace.

**The `base` / `Ansi` split.** `ansi-codes.ts` defines a private `base` object, then spreads it into the exported `Ansi` and appends five pre-composed log prefixes:

```ts
LOG_SUCCESS: `${base.FG_GREEN}✓${base.RESET}`,
```

The split exists purely so those five can reference the codes they are built from. Note that `LOG_*` are the **only** values in the module that reset themselves — they are complete, self-contained strings safe to drop anywhere in a line.

**A typing wrinkle worth knowing before you edit this file.** `Ansi` is declared `as const`, but `base` is not. Because the literal types are already widened to `string` by the time `base` is spread, `as const` on `Ansi` makes the properties `readonly` **but does not preserve string literal types**:

```ts
Ansi.RESET   // type: string       — not "\x1b[0m"
Emoji.SUCCESS // type: "✅"         — Emoji is `as const` on a plain literal
```

So you cannot build a union like `typeof Ansi[keyof typeof Ansi]` and get anything more specific than `string`. Adding `as const` to `base` would fix this, and is a non-breaking change for consumers who only concatenate. Both objects are `readonly` at the type level either way, and neither is `Object.freeze`d at runtime.

**`Emoji` is not strictly emoji.** Several entries are plain text-presentation Unicode characters rather than pictographic emoji: `DONE` (`✓` U+2713), `CHECK` (`✔` U+2714), `CROSS` (`✗` U+2717), `SKIP` (`⊘` U+2298), and the four `ARROW_*` glyphs. These are deliberate — they render at single-cell width in a monospace terminal, which most true emoji do not. See [Edge cases](#edge-cases) for the width consequences.

## API

Both objects are exported from `console-styles/index.ts`, which is a pure barrel re-exporting `./ansi-codes` and `./emoji`. There are no other exports, no default export, and no functions beyond the four color helpers below.

### `Ansi`

A readonly object of 86 entries: 82 string constants and 4 functions.

#### Cursor movement

| Name | Value | Effect |
| --- | --- | --- |
| `CURSOR_HOME` | `\x1b[H` | Move to row 1, column 1 |
| `CURSOR_UP` | `\x1b[A` | Up one row, same column |
| `CURSOR_DOWN` | `\x1b[B` | Down one row, same column |
| `CURSOR_FORWARD` | `\x1b[C` | Right one column |
| `CURSOR_BACK` | `\x1b[D` | Left one column |
| `CURSOR_NEXT_LINE` | `\x1b[E` | Down one row, to column 1 |
| `CURSOR_PREV_LINE` | `\x1b[F` | Up one row, to column 1 |
| `CURSOR_SAVE` | `\x1b[s` | Save the cursor position |
| `CURSOR_RESTORE` | `\x1b[u` | Restore the saved position |
| `HIDE_CURSOR` | `\x1b[?25l` | Hide the cursor |
| `SHOW_CURSOR` | `\x1b[?25h` | Show the cursor |

#### Line and screen clearing

| Name | Value | Effect |
| --- | --- | --- |
| `CLEAR_LINE` | `\r\x1b[K` | Carriage return, then erase to end of line — clears the line and parks the cursor at column 1 |
| `CLEAR_LINE_END` | `\x1b[K` | Erase from the cursor to end of line; cursor unmoved |
| `CLEAR_LINE_START` | `\x1b[1K` | Erase from start of line to the cursor; cursor unmoved |
| `CLEAR_LINE_FULL` | `\x1b[2K` | Erase the whole line; cursor unmoved |
| `CLEAR_SCREEN` | `\x1b[2J` | Erase the whole screen; cursor unmoved |
| `CLEAR_SCREEN_DOWN` | `\x1b[J` | Erase from the cursor to end of screen |
| `CLEAR_SCREEN_UP` | `\x1b[1J` | Erase from start of screen to the cursor |
| `CLEAR_SCROLLBACK` | `\x1b[3J` | Erase the scrollback buffer |

`CLEAR_LINE` is the composite one — the only entry in the file that combines two sequences — and is what you want for a redrawing status line.

#### Text attributes

| Name | Value | Effect |
| --- | --- | --- |
| `RESET` | `\x1b[0m` | Clear all attributes and colors |
| `BOLD` | `\x1b[1m` | Bold / increased intensity |
| `DIM` | `\x1b[2m` | Faint / decreased intensity |
| `ITALIC` | `\x1b[3m` | Italic |
| `UNDERLINE` | `\x1b[4m` | Underline |
| `BLINK` | `\x1b[5m` | Slow blink |
| `BLINK_FAST` | `\x1b[6m` | Rapid blink |
| `REVERSE` | `\x1b[7m` | Swap foreground and background |
| `HIDDEN` | `\x1b[8m` | Conceal — text occupies space but is not drawn |
| `STRIKETHROUGH` | `\x1b[9m` | Crossed out |
| `DOUBLE_UNDERLINE` | `\x1b[21m` | Double underline |
| `OVERLINE` | `\x1b[53m` | Line above the text |

#### Attribute resets

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

#### Foreground colors

| Name | Value | | Name | Value |
| --- | --- | --- | --- | --- |
| `FG_BLACK` | `\x1b[30m` | | `FG_GRAY` | `\x1b[90m` |
| `FG_RED` | `\x1b[31m` | | `FG_BRIGHT_RED` | `\x1b[91m` |
| `FG_GREEN` | `\x1b[32m` | | `FG_BRIGHT_GREEN` | `\x1b[92m` |
| `FG_YELLOW` | `\x1b[33m` | | `FG_BRIGHT_YELLOW` | `\x1b[93m` |
| `FG_BLUE` | `\x1b[34m` | | `FG_BRIGHT_BLUE` | `\x1b[94m` |
| `FG_MAGENTA` | `\x1b[35m` | | `FG_BRIGHT_MAGENTA` | `\x1b[95m` |
| `FG_CYAN` | `\x1b[36m` | | `FG_BRIGHT_CYAN` | `\x1b[96m` |
| `FG_WHITE` | `\x1b[37m` | | `FG_BRIGHT_WHITE` | `\x1b[97m` |
| `FG_DEFAULT` | `\x1b[39m` | | | |

`FG_GRAY` is the bright-black slot (`90`); there is no `FG_BRIGHT_BLACK` alias.

#### Background colors

| Name | Value | | Name | Value |
| --- | --- | --- | --- | --- |
| `BG_BLACK` | `\x1b[40m` | | `BG_GRAY` | `\x1b[100m` |
| `BG_RED` | `\x1b[41m` | | `BG_BRIGHT_RED` | `\x1b[101m` |
| `BG_GREEN` | `\x1b[42m` | | `BG_BRIGHT_GREEN` | `\x1b[102m` |
| `BG_YELLOW` | `\x1b[43m` | | `BG_BRIGHT_YELLOW` | `\x1b[103m` |
| `BG_BLUE` | `\x1b[44m` | | `BG_BRIGHT_BLUE` | `\x1b[104m` |
| `BG_MAGENTA` | `\x1b[45m` | | `BG_BRIGHT_MAGENTA` | `\x1b[105m` |
| `BG_CYAN` | `\x1b[46m` | | `BG_BRIGHT_CYAN` | `\x1b[106m` |
| `BG_WHITE` | `\x1b[47m` | | `BG_BRIGHT_WHITE` | `\x1b[107m` |
| `BG_DEFAULT` | `\x1b[49m` | | | |

#### Color helpers

##### `Ansi.fg256(n: number): string`

Returns `` `\x1b[38;5;${n}m` ``. `n` is an index into the standard 256-color palette: `0`–`7` the basic colors, `8`–`15` their bright variants, `16`–`231` a 6×6×6 RGB cube, `232`–`255` a 24-step grayscale ramp. No validation or clamping — see [Edge cases](#edge-cases). Never throws.

##### `Ansi.bg256(n: number): string`

As above, for the background. Returns `` `\x1b[48;5;${n}m` ``.

##### `Ansi.fgRGB(r: number, g: number, b: number): string`

Returns `` `\x1b[38;2;${r};${g};${b}m` ``. Each channel is expected to be `0`–`255`. Requires a truecolor-capable terminal; on a 256-color terminal the sequence is typically ignored, leaving the previous color in effect. No validation or clamping. Never throws.

##### `Ansi.bgRGB(r: number, g: number, b: number): string`

As above, for the background. Returns `` `\x1b[48;2;${r};${g};${b}m` ``.

#### Terminal modes

| Name | Value | Effect |
| --- | --- | --- |
| `ALT_SCREEN_ON` | `\x1b[?1049h` | Switch to the alternate screen buffer (what `vim` and `less` use) |
| `ALT_SCREEN_OFF` | `\x1b[?1049l` | Switch back, restoring the previous screen contents |
| `WRAP_ON` | `\x1b[?7h` | Wrap text past the right margin onto the next line |
| `WRAP_OFF` | `\x1b[?7l` | Truncate at the right margin instead of wrapping |

#### Bell

| Name | Value | Effect |
| --- | --- | --- |
| `BELL` | `\x07` | The BEL control character — audible beep or visual flash, depending on terminal configuration |

#### Log prefixes

The only pre-composed values. Each is `color + glyph + RESET`, so they are self-contained and safe to embed anywhere without leaking style.

| Name | Value | Renders as |
| --- | --- | --- |
| `LOG_SUCCESS` | `` `${FG_GREEN}✓${RESET}` `` | green `✓` |
| `LOG_ERROR` | `` `${FG_RED}✕${RESET}` `` | red `✕` |
| `LOG_WARN` | `` `${FG_YELLOW}⚠${RESET}` `` | yellow `⚠` |
| `LOG_INFO` | `` `${FG_BLUE}ℹ${RESET}` `` | blue `ℹ` |
| `LOG_DEBUG` | `` `${FG_MAGENTA}⚙${RESET}` `` | magenta `⚙` |

### `Emoji`

A readonly object of 140 named Unicode strings, grouped by comment in the source. Unlike `Ansi`, the values keep their string literal types (`Emoji.SUCCESS` is typed `"✅"`, not `string`).

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

### Colored log lines

```ts
import { Ansi } from "@isel-jao/ts-lib";

console.log(`${Ansi.LOG_SUCCESS} build finished in 1.2s`);
console.log(`${Ansi.LOG_ERROR} 3 tests failed`);

// Anything not from the LOG_* family needs an explicit reset.
console.log(`${Ansi.FG_YELLOW}${Ansi.BOLD}deprecated${Ansi.RESET} — use v2 instead`);
```

### Emoji as a prefix vocabulary

```ts
import { Emoji } from "@isel-jao/ts-lib";

const label = {
  pass: Emoji.SUCCESS,
  fail: Emoji.ERROR,
  skip: Emoji.SKIP,
} as const;

for (const result of results) {
  console.log(`${label[result.status]} ${result.name}`);
}
```

### Truecolor and the 256-color ramp

```ts
import { Ansi } from "@isel-jao/ts-lib";

// A severity color computed at runtime.
function heat(pct: number): string {
  const r = Math.round(255 * pct);
  const g = Math.round(255 * (1 - pct));
  return `${Ansi.fgRGB(r, g, 0)}${(pct * 100).toFixed(0)}%${Ansi.RESET}`;
}

// The 232-255 grayscale ramp, for dimming without losing legibility.
const muted = (s: string) => `${Ansi.fg256(244)}${s}${Ansi.RESET}`;
console.log(`${heat(0.87)} coverage ${muted("(threshold 90%)")}`);
```

### Guarding on TTY and `NO_COLOR`

The module does no environment detection at all, so this is yours to write. A minimal version:

```ts
import { Ansi } from "@isel-jao/ts-lib";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

/** Wrap `s` in `codes`, or return it untouched when color is off. */
function style(s: string, ...codes: string[]): string {
  return useColor ? `${codes.join("")}${s}${Ansi.RESET}` : s;
}

console.log(style("FAIL", Ansi.FG_RED, Ansi.BOLD), "connection refused");
```

Piped to a file, this writes `FAIL connection refused` with no escape bytes.

### A redrawing progress line

The non-trivial case: `CLEAR_LINE` plus `HIDE_CURSOR`, with the cursor restored in a `finally` so a thrown error or a `Ctrl-C` handler cannot leave the terminal without a cursor.

```ts
import { Ansi } from "@isel-jao/ts-lib";

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

`CLEAR_LINE` is `\r\x1b[K` — the `\r` returns to column 1 and `\x1b[K` erases the old, possibly longer, text. Using `\r` alone would leave the tail of the previous frame visible whenever the new frame is shorter.

### A full-screen view on the alternate buffer

```ts
import { Ansi } from "@isel-jao/ts-lib";

function fullScreen(render: () => string) {
  process.stdout.write(Ansi.ALT_SCREEN_ON + Ansi.HIDE_CURSOR);
  try {
    process.stdout.write(Ansi.CLEAR_SCREEN + Ansi.CURSOR_HOME + render());
  } finally {
    process.stdout.write(Ansi.SHOW_CURSOR + Ansi.ALT_SCREEN_OFF);
  }
}
```

`CLEAR_SCREEN` (`\x1b[2J`) erases but does not move the cursor, which is why `CURSOR_HOME` follows it. Getting this backwards is the classic "why is my output starting halfway down the screen" bug.

## Edge cases

### `Ansi`

| Case | Behavior |
| --- | --- |
| **Missing `RESET`** | SGR state is terminal-global and persists across writes and across process boundaries. `process.stdout.write(Ansi.FG_RED + "x")` leaves the terminal red — subsequent output from your program *and from the shell after it exits* stays red until something emits a reset. `LOG_SUCCESS`/`LOG_ERROR`/`LOG_WARN`/`LOG_INFO`/`LOG_DEBUG` are the only self-resetting values. |
| **Nesting** | There is no style stack. An inner `Ansi.RESET` clears the enclosing style too: in `` `${Ansi.FG_RED}a${Ansi.BOLD}b${Ansi.RESET}c` ``, `c` is unstyled, not red. To end just the bold, use `RESET_BOLD` and leave the color running. |
| **Non-TTY output** | **The module performs no TTY detection and no `NO_COLOR`/`FORCE_COLOR` handling whatsoever.** Redirected to a file or captured by a CI log collector, every sequence is written verbatim and shows up as `ESC[31m` / `^[[31m` / `\033[31m` noise depending on the viewer. Guard on `process.stdout.isTTY` at the call site, as shown in [Usage](#usage). This is the single biggest gap versus `chalk`. |
| **No strip helper** | There is no function to remove ANSI codes from a string. If you need to log a styled string to a file as well as a terminal, build the plain and styled forms separately or write your own `replace(/\x1b\[[0-9;]*m/g, "")`. |
| **`.length` ≠ display width** | `` (`${Ansi.FG_RED}x${Ansi.RESET}`).length `` is `10`, not `1`. `padStart`/`padEnd`, manual column math, and any table layout will be wrong on styled strings. Pad first, style second. |
| **`fg256`/`bg256` out of range** | No validation. `Ansi.fg256(999)` returns `"\x1b[38;5;999m"`; the terminal's response is undefined — most ignore it, leaving the previous color. Negative and fractional values are interpolated verbatim (`Ansi.fg256(1.5)` → `"\x1b[38;5;1.5m"`), producing a malformed sequence. `NaN` yields `"\x1b[38;5;NaNm"`. Clamp and round before calling. |
| **`fgRGB`/`bgRGB` on a non-truecolor terminal** | The sequence is typically ignored rather than approximated, so the text renders in whatever color was already active. There is no automatic downgrade to the 256 palette. |
| **`DOUBLE_UNDERLINE` (`21`)** | ECMA-48 assigns `21` to double underline, but a number of terminals historically implemented it as "bold off". Support is inconsistent; verify on your target terminal before relying on it. |
| **`BLINK` / `BLINK_FAST`** | Widely disabled or ignored by modern terminal emulators. `BLINK_FAST` (`6`) has even thinner support than `BLINK` (`5`). |
| **`CURSOR_SAVE`/`CURSOR_RESTORE`** | A single slot, not a stack. A second `CURSOR_SAVE` overwrites the first, so these do not nest. |
| **No parameterized movement** | Every cursor sequence is the no-parameter form and therefore moves exactly one cell or line. To move `n`, build the string yourself: `` `\x1b[${n}A` ``. |
| **`ALT_SCREEN_ON` without `OFF`** | Leaves the user's shell on the alternate buffer after your process exits, hiding their scrollback. Always pair it in a `finally`, and consider a `SIGINT` handler too. |
| **`HIDE_CURSOR` without `SHOW_CURSOR`** | Same failure mode — the user is left with an invisible cursor and usually has to run `reset` or `tput cnorm`. |
| **Windows** | Modern Windows Terminal and PowerShell handle these sequences. Legacy `conhost` requires virtual-terminal processing to be enabled by the host process; where it is not, sequences print as literal text. Nothing in this module enables it. |
| **Type of the values** | `Ansi` properties are `readonly` but typed `string`, not string literals, because `base` is spread in without its own `as const`. `Emoji` properties *do* carry literal types. Neither object is frozen at runtime. |

### `Emoji`

| Case | Behavior |
| --- | --- |
| **Duplicate values** | `DEBUG`/`BUG`, `ARCHIVE`/`PACKAGE`, `SIGNAL`/`WIFI`, and `PLUG`/`ELECTRIC` are alias pairs holding byte-identical strings. Comparing `Emoji.SIGNAL === Emoji.WIFI` is `true`. |
| **Variation selectors** | 27 entries carry U+FE0F (VS16) to force emoji presentation — `WARN` ⚠️, `INFO` ℹ️, `GEAR` ⚙️, `HEART` ❤️, `SUN` ☀️ and others. The rest do not. Entries such as `PAUSE` ⏸, `STOP` ⏹ and `RECORD` ⏺ omit VS16 and may render as monochrome text glyphs rather than color emoji, depending on the font. |
| **`CHAIN_BREAK` is a ZWJ sequence** | `⛓️‍💥` is U+26D3 U+FE0F U+200D U+1F4A5 — 4 code points, `.length === 5` in UTF-16. Terminals without support for this sequence render it as two separate glyphs (a chain and an explosion). |
| **`.length` ≠ display width** | Most entries are astral-plane characters with `.length === 2`. Many render two cells wide in a terminal; the text-presentation ones (`DONE` ✓, `CHECK` ✔, `CROSS` ✗, `SKIP` ⊘, the arrows) render one cell wide with `.length === 1`. Column alignment across mixed entries requires a real width table — `String.prototype.length` will not do it, and neither will `[...s].length`. |
| **Font dependence** | Rendering is entirely up to the terminal's font stack. A missing glyph appears as a tofu box, and the module has no fallback mechanism. `DONE`, `CHECK`, `CROSS`, `SKIP` and the `ARROW_*` set are the safest choices for wide terminal compatibility. |
| **Not a stable API surface for keys** | Keys are `SCREAMING_SNAKE_CASE` throughout, but the grouping comments carry no runtime meaning — `Emoji` is one flat object with no nesting. |
