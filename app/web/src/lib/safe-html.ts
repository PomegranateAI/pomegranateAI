import DOMPurify from 'dompurify';

/**
 * Sanitize HTML that came from stored content (note bodies, wiki blocks)
 * before it is rendered with dangerouslySetInnerHTML or handed to the editor.
 *
 * Note text can originate outside the team — an email pulled from Gmail, a
 * WhatsApp message, an ingested web page — so it is never trusted as markup.
 * DOMPurify keeps formatting (headings, lists, links, images, tables) and
 * drops scripts, event handlers, javascript: URLs, styles and embedded frames.
 */
export function safeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math'],
    FORBID_ATTR: ['style'],
  });
}

// Links in stored content open in a new tab without access to this window.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});
