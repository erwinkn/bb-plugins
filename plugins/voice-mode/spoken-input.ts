/** Discard non-verbal fragments, never words just because they are short. */
export function hasSpokenWords(text: string): boolean {
  const spoken = text.replace(/[\[(](?:noise|background noise|music|silence|blank_audio|inaudible|unintelligible|cough(?:ing)?|laughter|applause)[\])]/gi, "");
  const words = spoken.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 && !words.every(word => /^(?:u+h+|u+m+|e+r+m?)$/.test(word));
}
