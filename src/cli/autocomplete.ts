import * as readline from 'readline';
import type { Completer } from 'readline';
import {
  completionText,
  getSlashCommandSuggestions,
  type SlashCommandDefinition,
} from './command-registry';

export interface AutocompleteInputOptions {
  prompt: string;
  commands: SlashCommandDefinition[];
  maxSuggestions?: number;
}

interface KeypressKey {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

const INPUT_HISTORY: string[] = [];
const MAX_HISTORY = 100;
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function getTerminalColumns(): number {
  const columns = process.stdout.columns;
  if (typeof columns !== 'number' || !Number.isFinite(columns)) return 80;
  return Math.max(20, columns);
}

export function countWrappedLines(text: string, columns = getTerminalColumns()): number {
  const safeColumns = Math.max(20, columns);
  return text.split('\n').reduce((total, line) => {
    return total + Math.max(1, Math.ceil(visibleLength(line) / safeColumns));
  }, 0);
}

export function countRenderLines(
  lines: readonly string[],
  columns = getTerminalColumns()
): number {
  if (lines.length === 0) return 0;
  return lines.reduce((total, line) => total + countWrappedLines(line, columns), 0);
}

export function clearPreviousRender(
  output: NodeJS.WriteStream,
  lineCount: number,
  cursorRow = Math.max(0, lineCount - 1)
): void {
  if (lineCount <= 0) return;
  readline.cursorTo(output, 0);
  if (cursorRow > 0) {
    readline.moveCursor(output, 0, -cursorRow);
  }
  readline.clearScreenDown(output);
}

function rememberInput(input: string): void {
  const trimmed = input.trim();
  if (!trimmed) return;
  if (INPUT_HISTORY[INPUT_HISTORY.length - 1] !== input) {
    INPUT_HISTORY.push(input);
    if (INPUT_HISTORY.length > MAX_HISTORY) INPUT_HISTORY.shift();
  }
}

function applyCompletion(definition: SlashCommandDefinition): string {
  return completionText(definition);
}

export function createSlashCommandCompleter(
  commands: readonly SlashCommandDefinition[] | undefined = undefined
): Completer {
  return (line: string) => {
    const trimmedLeading = line.replace(/^\s+/, '');
    if (!trimmedLeading.startsWith('/')) return [[], line];

    const suggestions = getSlashCommandSuggestions(
      trimmedLeading,
      50,
      commands
    );
    const completions = suggestions.map(completionText);

    return [completions, trimmedLeading];
  };
}

function fallbackReadlineInput(options: AutocompleteInputOptions): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      completer: createSlashCommandCompleter(options.commands),
    });

    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      rememberInput(value);
      resolve(value);
    };

    rl.on('SIGINT', () => finish('/exit'));
    rl.on('close', () => finish('/exit'));
    rl.question(options.prompt, (answer) => finish(answer));
  });
}

export async function readLineWithSlashAutocomplete(
  options: AutocompleteInputOptions
): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const canUseRawMode =
    stdin.isTTY === true &&
    stdout.isTTY === true &&
    typeof stdin.setRawMode === 'function';

  if (!canUseRawMode) {
    return fallbackReadlineInput(options);
  }

  return new Promise((resolve) => {
    const maxSuggestions = options.maxSuggestions ?? 10;
    const wasRaw = stdin.isRaw === true;
    let buffer = '';
    let cursor = 0;
    let selectedIndex = 0;
    let lastRenderLineCount = 0;
    let lastCursorRow = 0;
    let suppressedForInput: string | null = null;
    let historyIndex = INPUT_HISTORY.length;
    let settled = false;

    const suggestionsForBuffer = (): SlashCommandDefinition[] => {
      if (buffer === suppressedForInput) return [];
      return getSlashCommandSuggestions(
        buffer,
        maxSuggestions + 1,
        options.commands
      );
    };

    const visibleSuggestions = (): SlashCommandDefinition[] => {
      return suggestionsForBuffer().slice(0, maxSuggestions);
    };

    const buildRenderLines = (): string[] => {
      const allSuggestions = suggestionsForBuffer();
      const suggestions = allSuggestions.slice(0, maxSuggestions);
      if (selectedIndex >= suggestions.length) selectedIndex = 0;

      const lines = [`${options.prompt}${buffer}`];

      if (suggestions.length > 0) {
        lines.push('');
        const commandWidth = Math.max(
          ...suggestions.map((item) => applyCompletion(item).length)
        );
        for (const [index, item] of suggestions.entries()) {
          const marker = index === selectedIndex ? '> ' : '  ';
          const command = applyCompletion(item).padEnd(commandWidth + 2);
          lines.push(`${marker}${command}${item.description}`);
        }
        if (allSuggestions.length > maxSuggestions) {
          lines.push(`  ... and ${allSuggestions.length - maxSuggestions} more`);
        }
      }

      return lines;
    };

    const render = (): void => {
      clearPreviousRender(stdout, lastRenderLineCount, lastCursorRow);

      const columns = getTerminalColumns();
      const lines = buildRenderLines();
      stdout.write(lines.join('\n'));

      lastRenderLineCount = countRenderLines(lines, columns);

      const inputCursorOffset = visibleLength(options.prompt) + cursor;
      const cursorRow = Math.floor(inputCursorOffset / columns);
      const cursorColumn = inputCursorOffset % columns;
      lastCursorRow = Math.min(cursorRow, Math.max(0, lastRenderLineCount - 1));

      const rowsUp = Math.max(0, lastRenderLineCount - 1 - lastCursorRow);
      if (rowsUp > 0) {
        readline.moveCursor(stdout, 0, -rowsUp);
      }
      readline.cursorTo(stdout, cursorColumn);
    };

    const restoreTerminal = (): void => {
      stdin.removeListener('keypress', onKeypress);
      stdout.removeListener('resize', onResize);
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(wasRaw);
      }
    };

    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearPreviousRender(stdout, lastRenderLineCount, lastCursorRow);
      stdout.write(`${options.prompt}${value}\n`);
      restoreTerminal();
      rememberInput(value);
      resolve(value);
    };

    const setBuffer = (value: string): void => {
      buffer = value;
      cursor = buffer.length;
      selectedIndex = 0;
      suppressedForInput = null;
    };

    const acceptSuggestion = (suggestion: SlashCommandDefinition): void => {
      buffer = applyCompletion(suggestion);
      cursor = buffer.length;
      selectedIndex = 0;
      suppressedForInput = buffer;
    };

    const navigateHistory = (direction: -1 | 1): void => {
      if (INPUT_HISTORY.length === 0) return;
      historyIndex += direction;
      if (historyIndex < 0) historyIndex = 0;
      if (historyIndex > INPUT_HISTORY.length) historyIndex = INPUT_HISTORY.length;
      setBuffer(INPUT_HISTORY[historyIndex] ?? '');
    };

    const insertText = (text: string): void => {
      buffer = `${buffer.slice(0, cursor)}${text}${buffer.slice(cursor)}`;
      cursor += text.length;
      selectedIndex = 0;
      suppressedForInput = null;
    };

    const onKeypress = (text: string, key: KeypressKey): void => {
      if (settled) return;

      if (key.ctrl === true && (key.name === 'c' || key.name === 'd')) {
        finish('/exit');
        return;
      }

      const suggestions = visibleSuggestions();
      const hasSuggestions = suggestions.length > 0;

      switch (key.name) {
        case 'return':
        case 'enter':
          if (hasSuggestions) {
            acceptSuggestion(suggestions[selectedIndex] ?? suggestions[0]!);
            render();
          } else {
            finish(buffer);
          }
          return;
        case 'escape':
          suppressedForInput = buffer;
          selectedIndex = 0;
          render();
          return;
        case 'tab':
          if (hasSuggestions) {
            acceptSuggestion(suggestions[selectedIndex] ?? suggestions[0]!);
            render();
          }
          return;
        case 'up':
          if (hasSuggestions) {
            selectedIndex =
              (selectedIndex - 1 + suggestions.length) % suggestions.length;
          } else {
            navigateHistory(-1);
          }
          render();
          return;
        case 'down':
          if (hasSuggestions) {
            selectedIndex = (selectedIndex + 1) % suggestions.length;
          } else {
            navigateHistory(1);
          }
          render();
          return;
        case 'left':
          if (cursor > 0) cursor -= 1;
          render();
          return;
        case 'right':
          if (cursor < buffer.length) cursor += 1;
          render();
          return;
        case 'home':
          cursor = 0;
          render();
          return;
        case 'end':
          cursor = buffer.length;
          render();
          return;
        case 'backspace':
          if (cursor > 0) {
            buffer = `${buffer.slice(0, cursor - 1)}${buffer.slice(cursor)}`;
            cursor -= 1;
            selectedIndex = 0;
            suppressedForInput = null;
          }
          render();
          return;
        case 'delete':
          if (cursor < buffer.length) {
            buffer = `${buffer.slice(0, cursor)}${buffer.slice(cursor + 1)}`;
            selectedIndex = 0;
            suppressedForInput = null;
          }
          render();
          return;
        default:
          break;
      }

      if (text && text >= ' ' && !key.ctrl) {
        insertText(text);
        render();
      }
    };

    const onResize = (): void => {
      if (!settled) render();
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);
    stdout.on('resize', onResize);
    render();
  });
}
