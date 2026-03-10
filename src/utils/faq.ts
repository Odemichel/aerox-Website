/** Extract FAQ items from raw MDX body for FAQPage schema */
export function extractFaqItems(body: string | undefined): Array<{ question: string; answer: string }> {
  if (!body) return [];
  // Find the FAQ section (FR or EN heading)
  const faqMatch = body.match(
    /(?:## |<h2>)(?:Questions fréquentes|Frequently Asked Questions)(?:<\/h2>)?\s*\n([\s\S]*?)(?=\n## [^#]|\n---|\n\*\*(?:Pour aller plus loin|Read more)|<\/div>\s*$|$)/
  );
  if (!faqMatch) return [];
  const faqSection = faqMatch[1];
  const items: Array<{ question: string; answer: string }> = [];
  // Parse <details><summary>question</summary> and <div>answer</div>
  const detailsRegex = /<details>\s*<summary>(.+?)<\/summary>\s*<div>(.+?)<\/div>\s*<\/details>/gs;
  let match;
  while ((match = detailsRegex.exec(faqSection)) !== null) {
    const question = match[1].trim();
    const answer = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (question && answer) {
      items.push({ question, answer });
    }
  }
  return items;
}
