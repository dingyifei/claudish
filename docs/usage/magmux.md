# Magmux

**A minimal terminal multiplexer for running AI models side by side.**

Magmux splits your terminal into panes, each running an independent command. Claudish uses it for `--grid` mode, where multiple models work on the same task in parallel and you watch them all at once.

It also works standalone -- three shell panes in your terminal with zero config.

---

## Quick start

```bash
# Install
brew install MadAppGang/tap/magmux

# Run with 3 shell panes (default layout)
magmux

# Run specific commands in each pane
magmux -e "htop" -e "tail -f /var/log/system.log"
```

You'll see a split terminal with a status bar at the bottom. Press `Ctrl-G` then `q` to quit.

---

## Why a multiplexer, and not just `claude -p`

Headless mode is not interactive-without-a-TTY. It diverges, and at least one divergence is
silent: an unknown `--agent` name exits 1 with the list of valid agents in interactive mode and
under plain `-p`, but under `--input-format stream-json` it exits **0**, prints nothing, and runs
the DEFAULT agent with the full tool set. The run reports `result: success`.

A magmux pane is a **real PTY running a real interactive session** — so the child behaves the way
interactive Claude Code behaves, not the way print mode does.

Crucially, that does not cost you a terminal. `--headless` refers to *magmux's* output, not the
pane's: no raw mode, no alternate screen, nothing on stdout, with the socket as the whole
interface. The panes are still PTYs.

| | child sees | unknown `--agent` | needs a terminal? |
|---|---|---|---|
| `claude -p --input-format stream-json` | no TTY, print mode | silently ignored, exit 0 | no |
| `claude` in a magmux pane, `magmux --headless` | real PTY, interactive | refused, agents listed | no |

So automation does not have to accept print mode's divergences in exchange for being scriptable.

Measurements and the upstream status are in `ai-docs/architecture/headless-vs-interactive.md`.

---

## With claudish

The `--grid` flag on `claudish team run` launches magmux with one pane per model. Each pane streams output in real time while a status bar tracks progress.

```bash
claudish team run --grid \
  --models kimi-k2.5,gpt-5.4,gemini-3.1-pro \
  --input "Refactor the auth module to use JWT"
```

What happens:

1. Claudish creates a session directory with anonymized model IDs
2. Generates a gridfile (one command per pane)
3. Launches magmux with the grid layout
4. Polls for completion and updates the status bar every 500ms

The status bar shows live progress:

```
 claudish team   3 done   32s   complete   ctrl-g q to quit
```

When models fail, the status bar turns red for those entries. Each pane shows a green `DONE` or red `FAIL` banner when finished.

### Two-model comparison

```bash
claudish team run --grid \
  --models google@gemini-3-pro,openai/gpt-5.1-codex \
  --input "Write a rate limiter for the API"
```

Two panes, side by side. Compare outputs visually as they stream.

### Three-model tournament

```bash
claudish team run-and-judge --grid \
  --models kimi-k2.5,grok-code-fast-1,gemini-3.1-pro \
  --judges glm-5 \
  --input "Design the database schema for a multi-tenant SaaS"
```

Three models run in grid mode. After all complete, GLM-5 blind-judges the anonymized outputs.

---

## Controls

Magmux uses a prefix key (`Ctrl-G`) for commands, similar to tmux's `Ctrl-B`.

| Key | Action |
|-----|--------|
| `Ctrl-G` then `q` | Quit magmux |
| `Ctrl-G` then `Tab` | Switch focus to next pane |
| `Ctrl-G` then `o` | Switch focus to next pane (alternative) |
| Mouse click | Focus the clicked pane |
| Mouse drag | Select text in the focused pane |
| Mouse release | Copy selection to clipboard |

### Mouse behavior

Click anywhere in a pane to focus it. Drag to select text -- the selection highlights in yellow (configurable).

When you release the mouse button, the selected text copies to your clipboard through two methods:

- **OSC 52** escape sequence (works over SSH)
- **pbcopy** fallback (local macOS)

Programs running in alternate screen mode (vim, htop, Claude Code) receive mouse events directly, matching tmux behavior.

---

## Pane layouts

The layout adapts to the number of commands:

| Panes | Layout |
|-------|--------|
| 1 | Fullscreen |
| 2 | Left / Right (50/50 split) |
| 3 | Top-left, Top-right, Bottom |

```bash
# 1 pane: fullscreen
magmux -e "claudish --model gemini-3-pro"

# 2 panes: side by side
magmux -e "claudish --model gemini-3-pro" -e "claudish --model grok-code-fast-1"

# 3 panes: default (runs your login shell in each)
magmux
```

---

## Standalone usage

Magmux works without claudish. Run any commands in split panes:

```bash
# Dev workflow: editor + server + tests
magmux -e "vim ." -e "npm run dev" -e "npm test -- --watch"

# Monitoring: logs + processes + disk
magmux -e "tail -f app.log" -e "htop" -e "watch df -h"
```

Each pane runs a full pseudo-terminal with `TERM=screen-256color`. Programs that detect screen/tmux TERM types render correctly.

---

## Configuration

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAGMUX_SEL_FG` | `0` (black) | Selection text color (256-color index) |
| `MAGMUX_SEL_BG` | `220` (yellow) | Selection background color (256-color index) |
| `MAGMUX_DEBUG` | unset | Write debug log to `/tmp/magmux-debug.log` |

```bash
# White text on blue selection
MAGMUX_SEL_FG=15 MAGMUX_SEL_BG=33 magmux
```

### Terminal compatibility

Magmux sets `TERM=screen-256color` for child processes. Programs that check for tmux or screen TERM values work correctly -- this matches what tmux itself does.

The VT-100 parser handles:
- 256-color and truecolor (24-bit RGB) escape sequences
- Bold, dim, italic, underline, strikethrough, overline attributes
- Alternate screen buffer (vim, htop, less)
- Scrollback buffer (1000 lines per pane)

---

## Install

### Homebrew (macOS)

```bash
brew install MadAppGang/tap/magmux
```

### Go install

```bash
go install github.com/MadAppGang/magmux@latest
```

### Build from source

```bash
git clone https://github.com/MadAppGang/magmux
cd magmux
go build -o magmux .
```

The binary has zero third-party dependencies beyond `golang.org/x/sys` and `golang.org/x/term`.

---

## Why magmux replaced MTM

Claudish originally used [MTM](https://github.com/deadpixi/mtm), a C-based terminal multiplexer. Magmux is a Go port of MTM's core VT engine (~2,100 lines) with these advantages:

- **Same tech stack** -- Go is readable by the claudish community; C was not
- **Single file** -- one `main.go`, no Makefile, no system library dependencies
- **Clipboard integration** -- mouse drag-to-select with OSC 52 + pbcopy
- **Status bar** -- tab-separated colored pills for team-grid progress display

The C MTM binary still ships in the repo (`packages/cli/native/mtm/`) as a fallback. The `team-grid.ts` orchestrator currently resolves whichever binary is available.

---

## Troubleshooting

### Panes show garbled output

**Cause**: The terminal emulator does not support SGR mouse mode or 256-color.

**Fix**: Use a modern terminal -- iTerm2, Ghostty, Kitty, or Alacritty. The default macOS Terminal.app works but has limited truecolor support.

### Text selection does not copy

**Cause**: OSC 52 clipboard access is disabled in your terminal, and `pbcopy` is not available (non-macOS).

**Fix**: Enable "Allow clipboard access from terminal" in your terminal settings. On Linux, install `xclip` or `xsel` and alias `pbcopy` to it.

### Ctrl-G does nothing

**Cause**: Your shell or program intercepts `Ctrl-G` (the BEL character) before magmux sees it.

**Fix**: Magmux receives raw input, so this is rare. If it happens in a specific program, try clicking the pane first to ensure focus, then press `Ctrl-G` followed by the command key.

### Status bar shows stale data in grid mode

**Cause**: The claudish poller writes the status bar file every 500ms. Brief delays between model completion and status bar update are normal.

**Fix**: Wait a moment. The final status always reflects the true state after all models finish.

---

## Next

- **[Interactive mode](interactive-mode.md)** -- Single-model sessions
- **[MCP server](mcp-server.md)** -- Use models as tools inside Claude Code
