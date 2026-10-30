# Text faces

Self-hosted copies of the three text families, declared in `src/styles/fonts.css`. Each file is
byte-for-byte the woff2 the Google Fonts CSS API served on 2026-10-30 for the request `index.html`
used to make (`family=Geist:wght@300..600&family=Geist+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,300`),
to a current Chrome. Only the `latin` and `latin-ext` subsets are kept; the Google path column
is the file's path on Google's font host, for tracing an update. Each family's licence travels in
the `OFL-*.txt` beside it, copied from the upstream repository.

Switzer (the figures) is not here: its licence keeps the files out of a public repository, so it
stays on the Fontshare CDN (see `src/index.css`).

| File | Family (designer) | Licence | Bytes | Google path | sha256 |
| --- | --- | --- | --- | --- | --- |
| `geist-latin.woff2` | Geist, latin, roman, variable wght (Vercel, with basement.studio) | OFL 1.1, `OFL-Geist.txt` | 29288 | `s/geist/v5/gyByhwUxId8gMEwcGFWNOITd.woff2` | `9b6f5ff45b278c744b5f379a2c4ecbaf858a842b8eaf82ac8d21b699ca16c608` |
| `geist-latin-ext.woff2` | Geist, latin-ext, roman, variable wght (Vercel, with basement.studio) | OFL 1.1, `OFL-Geist.txt` | 16540 | `s/geist/v5/gyByhwUxId8gMEwSGFWNOITddY4.woff2` | `58a6b173d5ca1dec92166ea3c6cb1a84a4144556d10928ac14e8e6b40e4787bd` |
| `geist-mono-latin.woff2` | Geist Mono, latin, roman, variable wght — serves 400 and 500 (Vercel, with basement.studio) | OFL 1.1, `OFL-Geist-Mono.txt` | 23108 | `s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrcdmhHkjko.woff2` | `5f3d6ad60f29d6cb708414ec6887163d63bf197377ef5417d2483ff31ace6c3b` |
| `geist-mono-latin-ext.woff2` | Geist Mono, latin-ext, roman, variable wght — serves 400 and 500 (Vercel, with basement.studio) | OFL 1.1, `OFL-Geist-Mono.txt` | 14712 | `s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrkdmhHkjkotbA.woff2` | `745994b5cd950ec201b66526375f057d540847cccfc70f4f24f5f571d26d3923` |
| `newsreader-latin.woff2` | Newsreader, latin, roman, variable wght + opsz — serves 300 and 400 (Production Type) | OFL 1.1, `OFL-Newsreader.txt` | 131848 | `s/newsreader/v26/cY9AfjOCX1hbuyalUrK4397yjIJFJpc.woff2` | `01817351be3edfc1714fe6d60ddea6a22a169a5ebd033b50c7f9495e5d9c386a` |
| `newsreader-latin-ext.woff2` | Newsreader, latin-ext, roman, variable wght + opsz — serves 300 and 400 (Production Type) | OFL 1.1, `OFL-Newsreader.txt` | 86628 | `s/newsreader/v26/cY9AfjOCX1hbuyalUrK439DyjIJFJpeBZQ.woff2` | `cbca001188852d514d8654be7ddc97868f039bdf986b926ec5c985c117853cfd` |
| `newsreader-italic-latin.woff2` | Newsreader, latin, italic 300, variable opsz (Production Type) | OFL 1.1, `OFL-Newsreader.txt` | 64168 | `s/newsreader/v26/cY9XfjOCX1hbuyalUrK439vogqCz_goCYw7oRYCJFYYzbARA_n8.woff2` | `c72d07a1db964cc91a869ee09283ee392f9710070279b9f661444771136c0a01` |
| `newsreader-italic-latin-ext.woff2` | Newsreader, latin-ext, italic 300, variable opsz (Production Type) | OFL 1.1, `OFL-Newsreader.txt` | 39052 | `s/newsreader/v26/cY9XfjOCX1hbuyalUrK439vogqCz_goCYw7oRYCJFYgzbARA_n8IsQ.woff2` | `b1d227d40d7732846c1007ee1afb4c66f8a26f87d176b48512a10015622c1a02` |

Upstream:

| Licence file | Family | Copied from |
| --- | --- | --- |
| `OFL-Geist.txt` | Geist | https://github.com/vercel/geist-font/blob/b5d164a0c066c2c9bfcd5ab65dd8244551f0ac06/OFL.txt |
| `OFL-Geist-Mono.txt` | Geist Mono | https://github.com/vercel/geist-font/blob/b5d164a0c066c2c9bfcd5ab65dd8244551f0ac06/OFL.txt (Geist Mono ships from the same repository under the same licence) |
| `OFL-Newsreader.txt` | Newsreader | https://github.com/productiontype/Newsreader/blob/cfcb4f7af0e52c25e8df2a2431814c8e5fe2e155/OFL.txt |

The copyright lines in the licence files match the ones embedded in the fonts' name tables.
