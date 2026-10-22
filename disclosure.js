// Shared by content.js and popup.js. Disclosure paragraphs are separated by "\n" (from <br> on the store page).
const SADS_PRIORITY_PREFIXES = ['generative ai', 'gen ai', 'gen-ai', 'genai', 'ai-generated', 'ai generated'];

function sadsStartsWithPriority(sentence) {
  const s = sentence.replace(/^[^a-z0-9]+/i, '').toLowerCase();
  return SADS_PRIORITY_PREFIXES.some((prefix) => s.startsWith(prefix));
}

function sadsIsPriorityParagraph(paragraph) {
  return paragraph.split(/(?<=[.!?])\s+/).some(sadsStartsWithPriority);
}

function sadsDisplayDisclosure(text, smart, separator = ' ') {
  const paragraphs = text.split('\n').filter(Boolean);
  if (!smart || paragraphs.length < 2) return paragraphs.join(separator);
  const priority = [];
  const rest = [];
  for (const paragraph of paragraphs) {
    (sadsIsPriorityParagraph(paragraph) ? priority : rest).push(paragraph);
  }
  return [...priority, ...rest].join(separator);
}
