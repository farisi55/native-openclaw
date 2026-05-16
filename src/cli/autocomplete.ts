import type { Completer } from 'readline';
import { completionText, getSlashCommandSuggestions } from './command-registry';

export function createSlashCommandCompleter(): Completer {
  return (line: string) => {
    const trimmedLeading = line.replace(/^\s+/, '');
    if (!trimmedLeading.startsWith('/')) return [[], line];

    const suggestions = getSlashCommandSuggestions(trimmedLeading);
    const completions = suggestions.map(completionText);

    return [completions, trimmedLeading];
  };
}
