# Contributing to Hopline

Thank you for looking. Hopline is a small tool for following Bitcoin through the chain, in your browser, with nothing stored on a server. Fixes, tests, documentation and corrections to wallet names are all welcome.

## Before you start

- **A bug or a question:** open an issue. Say what you did, what you expected and what happened, and include the transaction id or address if it is public data.
- **Small fixes:** just open a pull request.
- **Anything bigger:** open an issue that describes the idea first, so we can agree on it before you spend days on it. A draft pull request works too.
- **A security problem:** do not use an issue or a pull request. See [SECURITY.md](SECURITY.md).
- **Real case data never belongs here.** No client names, no engagement data, no reports or screenshots from real work. Use public chain data (the fixtures in `test/fixtures` are public transactions) or invent addresses.

## What decides whether something is merged

1. **Local first.** The pages run in the browser, and nothing about a wallet leaves the machine except the requests to the data source the user chose and, only when the user has switched on the optional Claude option (off whenever the page opens) and confirmed that send, the assistant's evidence to `api.anthropic.com` (the address is fixed in `public/js/hopline-assist.js`; no setting changes it). A plain copy tracks nothing: the visit counter in `public/js/hopline-stats.js` does nothing unless `public/config.js`, written when the live site is built, turns it on, and it only ever sends page and feature names.
2. **Nothing to install and nothing to build for the app.** Plain JavaScript files loaded by script tags, no framework, no CDN, no run-time dependencies, and it works when `index.html` is opened from disk.
3. **Anything optional that talks to a third party is off by default** and says plainly what it sends.
4. **A name is a claim, a pattern is a guess.** Results of the analysis say what they are and why, and never present a heuristic as a finding.
5. **Everything shown is untrusted.** Names, notes, imported files and replies from explorers go into the page as text (`textContent`), never as HTML, and generated files escape what they write.
6. **Bitcoin only for now.** Other chains are on the [roadmap](ROADMAP.md).

## Setting up

You need Node 20 or newer and Python 3.8 or newer.

- Run the pages locally: `python tools/serve.py`, then open <http://127.0.0.1:8000/index.html>. It is a small server that asks the browser to keep nothing, so you always see your latest code.
- Unit tests: `node --test "test/*.test.js"`
- Tool tests (report verifier, OFAC label pack, site build): `pip install pytest`, then `python -m pytest test/tools`
- Browser tests: `pip install pytest playwright && playwright install firefox`, then `python -m pytest test/e2e`. The data source is mocked from the fixtures, so no network is needed. The whole suite takes about half an hour, so run the files for the area you changed.

When you push to `master`, a workflow runs the unit and tool tests before anything is published. Pull requests from forks do not run it and never get any secrets.

## Code

- **Layout.** `public/js/hopline-*.js` are small modules. The ones without the DOM (model, filter, layout, analysis, ...) have unit tests in `test/`; `workspace.js` and `wallet.js` are the pages' own code; browser tests live in `test/e2e`.
- **Style.** Match the code around yours: plain `var` JavaScript in the existing module wrapper, and comments that say why, not what.
- **Tests.** A fix comes with a test that fails without it, and a new feature with tests for what it promises. Please do not reformat code you are not changing.
- **Docs.** If you change what a page does, change the README or the in-app help in the same pull request. The longer documentation lives in the [wiki](https://github.com/forensicworks/hopline/wiki), which only the maintainers can edit: open an issue for a correction.

## Wallet names

The built-in list is `public/data/known-addresses.js`. A name needs a **public source** you can link in the pull request. Keep it factual (what the source says, not what you infer), and never add anything taken from private or client work. Sanctions entries come from the official list through the converter in `tools/make_label_pack_ofac.py`, not by hand.

## Pull requests

- One topic per pull request, branched from `master`.
- Say what changed and why, and which tests you ran.
- Commit messages: a short subject in the imperative, then a few plain sentences on what and why.
- Git records your email in every commit and the history is public. If you would rather not show yours, use your GitHub no-reply address (GitHub, Settings, Emails).
- By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as section 5 of that licence describes. There is no separate agreement to sign, and you keep your copyright.
- I review when I can, and I may ask for changes or decline something that does not fit the principles above.
