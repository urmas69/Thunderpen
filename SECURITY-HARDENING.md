# Security hardening after the 1.1.3.1 English source import

Changes in this branch:

- Do not reconstruct remote `http(s)` image URLs from original messages on reply/forward. This prevents silently reintroducing external trackers and removes the need for `messagesRead`.
- Remove diagnostic logging that included `<img>` markup, remote URLs, and potentially sensitive tracking query parameters.
- Request the latest TinyMCE HTML **before** removing the toolbar for sending; cancel sending if the editor times out, returns an invalid response, does not acknowledge preparation, or Thunderbird rejects `setComposeDetails`. Do not silently send cached or empty fallback HTML.
- Remove `messagesRead` from the extension manifest. Other Thunderbird permissions remain unchanged.

## Validation completed

- GitHub commits verified.
- JavaScript syntax compilation of `background.js` and `compose/inject.js` passed.

## Thunderbird regression tests required before release

1. New message: edit, send, inspect received MIME HTML. Ensure no `kc-toolbar`/`tox-` nodes are included.
2. Save draft, close, reopen, verify text, tables, attachments and signature remain intact.
3. Reply/forward with inline `cid:` images and original remote `https:` images. Verify images do not disappear and remote URLs are not unexpectedly restored.
4. Simulate editor disconnect or delayed response before Send; sending must be cancelled, with the draft intact.
5. After a Thunderbird send failure, confirm compose window remains usable; the current toolbar-removal design needs specific regression testing.
6. Verify the format painter, HTML source view, copy/paste and Close Editor fallback.

## Outstanding

- `valid_elements: '*[*]'` in `compose/inject.js` is extremely permissive. It was not changed here because blindly restricting it risks damaging legitimate forwarded HTML. Requires a separately tested HTML sanitization policy.
- Third-party TinyMCE/minified assets have not been independently fully audited.
- The current branch is a development candidate, **not** a fully validated or published update.
