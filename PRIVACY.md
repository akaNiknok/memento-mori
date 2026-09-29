# Privacy

Memento Mori is a personal finance tracker. It has one user: the owner of this repository. Nobody else can sign in.

The Google Apps Script part reads the bank emails that have the label "Memento Mori" in the owner's Gmail. It sends the text to the owner's own Cloudflare Worker. The Worker sends the text to the Google Gemini API to read the transaction. The script also writes one backup file to the owner's Google Drive.

The project does not sell data, share data or show advertisements. It keeps no data about any person other than the owner.
