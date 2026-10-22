// Prefill LinkedIn's own composer. No API token: the person posts from their logged-in browser tab.

export function linkedinShareUrl(text) {
  return 'https://www.linkedin.com/feed/?shareActive=true&text=' + encodeURIComponent(String(text ?? ''));
}
