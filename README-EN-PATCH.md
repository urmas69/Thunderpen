# Thunderpen 1.1.3 English UI patch

Based on the installed Thunderbird extension v1.1.3, NOT the older public GitHub main (v1.0.21).

Changes: English UI in compose toolbar and dialogs, settings, signature editor, default English for new installations, manifest title and v1.1.3.1. TinyMCE third-party assets and mail sending code untouched. Existing stored language preferences are preserved.

To package (unsigned) on Windows with PowerShell:
```powershell
Compress-Archive -Path .\manifest.json,.\background.js,.\compose,.\options,.\signature,.\tinymce,.\icons -DestinationPath ..\thunderpen-english.zip -Force
Rename-Item ..\thunderpen-english.zip thunderpen-english.xpi
```

**Unsigned XPI:** regular Thunderbird installation may reject it due to add-on signing. Testing may require Thunderbird's temporary add-on loading or obtaining a signed release through addons.thunderbird.net. This package is not signed.
