# Consistent HTML email formatting (development candidate)

The HTML compose editor now normalizes pasted HTML and the final HTML passed to Thunderbird.

- Default typography: Arial/Helvetica 14px, 1.5 line height, #222 text.
- Paragraph spacing: 12px; lists: 24px left indentation; table cell padding: 4px 8px.
- Remove source font faces, sizes, colors, inline styles and decorative spans.
- Preserve semantic bold, italic, hyperlinks, ordered/unordered lists and tables.
- Convert CSS-only bold and italic spans into semantic strong/em.
- Convert heading tags to normal-size bold paragraphs to avoid oversized pasted headings.
- Retain existing image references, with image-related regressions still requiring separate Thunderbird testing.

**Important:** This does NOT convert a Thunderbird compose window configured as plain-text into HTML.
If the final EML has only `Content-Type: text/plain` (as in test3), use Thunderbird's HTML compose mode.
For a mixed environment, a future follow-up could offer a prominent 'Switch to HTML' control.

## Reproduction tests

1. Paste the HTML body of test1.eml. Expect Arial 14px, paragraphs with consistent gaps and bold headings.
2. Paste the HTML body of test2.eml. Expect Segoe UI spans eliminated, but bold text and bullets retained.
3. Paste the text of test3.eml into an HTML compose window. Expect Arial 14px and HTML MIME on send.
4. Save and reopen drafts; inspect incoming/sent MIME and confirm no nested font tags or multiple source styles.
5. Test tables, links, numbered lists, inline images, signatures and replies/forwards. In particular, inspect whether the sanitizer alters signature graphics or quoted-message structure.

This feature is **not yet Thunderbird-runtime verified** and should not be merged until these tests pass.
