import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { linkedinShareUrl } from './linkedin-share.js';

test('LinkedIn share URL prefills the composer with encoded draft text', () => {
  assert.equal(
    linkedinShareUrl('Hello world & more'),
    'https://www.linkedin.com/feed/?shareActive=true&text=Hello%20world%20%26%20more'
  );
  assert.equal(
    linkedinShareUrl('Line one\n\nLine two'),
    'https://www.linkedin.com/feed/?shareActive=true&text=Line%20one%0A%0ALine%20two'
  );
  assert.equal(linkedinShareUrl(''), 'https://www.linkedin.com/feed/?shareActive=true&text=');
  assert.equal(linkedinShareUrl(null), 'https://www.linkedin.com/feed/?shareActive=true&text=');
});

test('Studio page uses the same LinkedIn composer URL', () => {
  const html = readFileSync(new URL('./app.html', import.meta.url), 'utf8');
  assert.match(html, /function linkedinShareUrl/);
  assert.match(html, /linkedin\.com\/feed\/\?shareActive=true&text=/);
  assert.match(html, /id="previewLi"/);
  assert.match(html, /Opened LinkedIn composer, text copied/);
});
