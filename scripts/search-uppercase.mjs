/** Normalize English letters consistently with the Nori mapping character filter. */
export function uppercaseSearchText(value) {
  return value.normalize('NFKC').replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

export function uppercaseDictionaryRules(rules) {
  const byWord = new Map();
  for (const rule of rules) {
    const normalized = uppercaseSearchText(rule).trim().replace(/\s+/g, ' ');
    const word = normalized.split(' ')[0];
    const previous = byWord.get(word);
    if (previous && previous !== normalized && previous.includes(' ') && normalized.includes(' ')) {
      throw new Error(`Conflicting dictionary decompositions: ${word}`);
    }
    if (!previous || normalized.includes(' ')) byWord.set(word, normalized);
  }
  return [...byWord.values()];
}

/** Mutates only inline Nori analyzers in a managed template. */
export function uppercaseNoriTemplate(body) {
  const settings = body.template?.settings;
  const analysis = settings?.index?.analysis ?? settings?.analysis;
  if (!analysis) return;
  for (const analyzer of Object.values(analysis.analyzer || {})) {
    const tokenizer = analysis.tokenizer?.[analyzer.tokenizer];
    if (tokenizer?.type !== 'nori_tokenizer' || tokenizer.user_dictionary) continue;
    tokenizer.user_dictionary_rules = uppercaseDictionaryRules(tokenizer.user_dictionary_rules || []);
    analysis.char_filter ??= {};
    analysis.char_filter.search_uppercase = {
      type: 'mapping',
      mappings: Array.from('abcdefghijklmnopqrstuvwxyz', (letter) => `${letter} => ${letter.toUpperCase()}`),
    };
    analyzer.char_filter = [...(analyzer.char_filter || []).filter((name) => name !== 'search_uppercase'), 'search_uppercase'];
    analyzer.filter = [...(analyzer.filter || []).filter((name) => name !== 'lowercase' && name !== 'uppercase'), 'uppercase'];
  }
}
