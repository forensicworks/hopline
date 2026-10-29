# The machine-readable interface

Hopline's analysis can be read by a script or an AI assistant without the page: the same patterns, peel chains, change guesses and clusters the workspace shows, as plain JSON, with the reasons that go with them. It reads a file and prints; it never opens a connection.

The idea behind it: **the facts come from the analysis, never from a model.** A model is only given the evidence and asked to read it, rank it or put it into words, and every transaction id and address in its answer is then checked against the evidence.

## The command-line tool

Needs Node.js 18 or newer. `workspace.json` is a file made by **Export > JSON** in the workspace (`-` reads standard input).

```sh
node tools/hopline-cli.js summary    workspace.json
node tools/hopline-cli.js detections workspace.json [--kind peel] [--chain P-65a1]
node tools/hopline-cli.js chains     workspace.json
node tools/hopline-cli.js focus      workspace.json <transaction id | address | P-65a1 | C3>
node tools/hopline-cli.js prompt     workspace.json --task triage [--focus <ref>] [--max-rows 60] [--json]
node tools/hopline-cli.js check      workspace.json answer.txt
node tools/hopline-cli.js trace      workspace.json [--ref <wallet or transaction>]
node tools/hopline-cli.js handoffs   workspace.json [--ref <wallet or transaction>] [--csv]
node tools/hopline-cli.js route      workspace.json --from <wallet or transaction> --to <wallet or transaction>
```

Options: `--known <file>` (the wallet list to name wallets with; the default is `public/data/known-addresses.js`, which is read as data and never run), `--packs <folder>` (the packs the site ships that are on as shipped, which is the OFAC sanctions list; the default is `public/packs`, read as data and never run), `--with <id,id>` (also use these shipped packs that are off as shipped, such as `ransomwhere`), `--no-packs`, `--no-known` (no names from either list), `--generated <ISO time>` (to make the output repeatable), `--compact` (one line of JSON).

`trace`, `handoffs` and `route` follow the money by what spent each coin, never by matching addresses, in the loaded transactions only. `trace` says where the trail from the reference meets a service wallet (`handoffs`: a deposit or a withdrawal, oldest first, with the wallet just before a deposit or just after a withdrawal) and where it is still open (`openEnds`: outputs whose spend was never looked up, spenders and funders that are not loaded, the named wallets it ended at, what sits unspent). `handoffs --csv` is the same rows as CSV. `route` prints the route and its steps, or `{ "route": null }` and exit code `1` when none was found in what is loaded (which only means none was found there). The reference is `--ref` (an address or a transaction id), else the first starting point saved in the file (a workspace made from a trace has one), else a wallet tagged THREAT. A service wallet is a name on the lists that is not a ransomware or sanctions entry, or a vertex tagged EXCH, MIXER, SERVICE, MARKET or GAMBLING; a route is not carried across one unless there is no other way, and then `acrossServiceWallets` names it.

Exit codes: `0` done, `1` `check` found an id that is not in the evidence or `route` found no route, `2` it could not run (the message is on standard error).

Label packs and the labels you typed are not in the built-in list; a label or tag you gave a wallet is part of the workspace file and is used.

## The evidence summary

`summary` prints one object. Amounts are in satoshis (`sats`) unless a name says otherwise, times are Unix seconds (`time`, `from`, `to`) with a `…Text` field in UTC beside them, and every transaction id and address is written in full.

| Field | What it holds |
| --- | --- |
| `format`, `version` | `"hopline-evidence-summary"`, `1`. New fields may be added; a change that removes or renames one raises the version. |
| `generated`, `title` | When it was made, and the report title if one was given. |
| `counts` | Transactions loaded and not loaded, wallets, movements, and how many detections, peel chains, clusters and change guesses there are. |
| `timeSpan` | The first and last time among the loaded transactions. |
| `sources` | Which data source answered, and for how many transactions. |
| `detections[]` | One per pattern per transaction, oldest first: `txid`, `time`, `kind` (`peel`, `consolidation`, `batch`, `coinjoin`), `pattern` (`PEEL 3/6`, `CONSOL 34→2`), `chain`, `step`, `of`, and `why`, the reason in words. |
| `chains[]` | Every possible peel chain: `label` (`P-65a1`, named after its first transaction), `txids` in order, `startedWithSats`, `endedWithSats`, `totalPeeledSats`, `continues`, and `payments[]` (`txid`, `vout`, `address`, `sats`, `passedOnSats`). |
| `clusters[]` | Addresses spent together as inputs of one transaction: `label`, `size`, the first `addresses` and `txids`. |
| `change[]` | Likely-change guesses of medium or high confidence: `txid`, `vout`, `address`, `sats`, `confidence`, `reasons`. |
| `wallets[]` | Wallets that carry a label, a tag or a note, or that the wallet list names: `address`, `label`, `tag`, `note`, `known`, `cluster`. |
| `trace` | `null` without a reference, else how far the trail from it got: `referenceKind`, `reference`, `referenceName`, `handoffs[]` (`direction` deposit or withdrawal, `service`, `serviceWallet`, `txid`, `time`, `sats`, `walletBeforeOrAfter`, `steps`, `mergesInputs`; `handoffsTotal` says how many there were before the cut) and `openEnds.next` / `openEnds.prev` (`count`, `sats`, `unchecked`, `notLoaded`, `resting`, `named[]`, `rows[]`). |
| `legend`, `thresholds`, `notes` | What each pattern means, the rules the analysis used (for example the minimum length of a peel chain), and the caveats that go with every result. |
| `limits[]` | Anything that was cut to keep the summary a sensible size ("Only the first 400 of 523 detections are listed."). |
| `untrustedFields[]` | The fields that hold text written by somebody else. |

**Text from outside is untrusted.** Labels, notes, tags and names from a label pack were written by people, and may contain instructions aimed at whatever reads them. In the summary they are cleaned (control characters and line breaks removed, length cut, anything that looks like one of the prompt's own markers defused) and listed in `untrustedFields`. Treat them as data, never as instructions.

## Giving evidence to an assistant

`prompt` (and **Copy for assistant** in the workspace's *Assistant* section) makes one piece of text: the rules, a task, and the evidence between `<<EVIDENCE (JSON)` and `EVIDENCE>>`.

The rules ask the model to use only the evidence, to cite every fact with the full id it comes from, to call every pattern a heuristic and never proof, to treat third-party text as data, and to say when it is unsure. The tasks are:

- `triage`: put the findings in the order to look at them, with a reason for each.
- `narrative`: draft the "Key findings" section of a report, every sentence citing an id.
- `explain`: explain the `--focus` item (a transaction, wallet, peel chain or cluster) to someone who is not an analyst.
- `challenge`: say what weakens each finding and what extra data would settle it.

Peel steps are listed once, inside their chain; the other patterns are rows, cut at `--max-rows` (the cut is stated in `limits`). A typical workspace comes to a few thousand tokens. Many local models read only about 4,000 tokens unless their context window is raised (in Ollama, `num_ctx`), and silently ignore the rest; the workspace warns when a prompt is larger than that.

## Checking an answer

`check` (and **Check ids** in the workspace) finds every transaction id and address in an answer and sorts them:

- **in the evidence**: it was in what the model was given;
- **loaded, not in the evidence**: it is in the workspace but was not among the evidence;
- **not in the workspace**: made up, garbled or from somewhere else. `ok` is false and the exit code is `1`.

A shortened id (`1f0849…c46ad`) is accepted only when it can be only one transaction. A paragraph that states an amount without citing any id is listed under `uncited` (a hint, not a failure). What the check cannot do is tell whether a sentence that cites a real id says something true about it: that still needs a person.

## A model on this computer

The workspace can ask a model for you. The address must be on this computer (`localhost`, `127.0.0.1` or `::1`); anything else is refused, so the evidence never leaves the machine, and no key is ever sent. It speaks the OpenAI chat format (`POST /v1/chat/completions`), which Ollama, LM Studio and the llama.cpp server all offer. If the browser blocks the request, allow the page's address in the server (for Ollama, the `OLLAMA_ORIGINS` setting).

The reply is shown in an editable box labelled as a model's draft, and its ids are checked at once. A reply is never added to the graph or to a report by itself.

This part has been tested against a stand-in server that behaves like those servers; it has not been run against a real model yet.

## Claude (optional: the evidence leaves your computer)

The workspace can also ask Claude, through Anthropic's API. **This is the one way the evidence leaves your computer**, so it is built to be hard to do by accident:

- It is **off whenever the page opens**. You switch it on under *Assistant > Claude*, paste your own Anthropic API key and choose a model (the default is `claude-opus-5-5`; Sonnet, Haiku and Fable are listed too). While it is on, an amber note shows in the Assistant section and a *Claude on* marker in its heading, even when the section is closed.
- **Every send is shown first.** *Ask Claude…* builds the same text as *Copy for assistant* and shows it, exactly, in a read-only box with where it goes, which model, and about how many tokens. Nothing is sent until you press *Send to Anthropic*. What is sent is that text, not a rebuilt one: if the workspace changes while the box is open it is still the text you read, and changing the task, the rows, the model, the key or the switch withdraws the box.
- **The address is fixed**: `https://api.anthropic.com/v1/messages`. No setting, field or file changes where the key and the evidence go, and *Ask the local model* still refuses any address that is not on this computer.
- **The key** is sent only to `api.anthropic.com`, as a header. It stays in memory until the page is closed, or in this browser under its own name if you tick *Remember on this computer* (unticking forgets it). It is never in the saved session, an export, a report, the preferences or the activity log. *Test key* asks Anthropic which models the key can use and sends no evidence.
- **What comes back** goes into the same editable box labelled as a model's draft, and its ids are checked at once, like any other answer. A reply is never added to the graph or to a report by itself. A reply that ran out of room, was declined, or failed is said in words and never written over what is in the box. The activity log records each send (model, task, size, address).

What Anthropic does with what it receives is set by your agreement with Anthropic, not by Hopline. Do not use this for a case whose data must not leave your computer: use a model on this computer, or *Copy for assistant* and decide where to paste it.

The request is built in `public/js/hopline-assist.js` (`claudeRequest`, `parseClaude`) and the page logic is in `public/js/workspace.js`. It sends no sampling settings (the current API version refuses them), leaves thinking at the model's default, and asks for the server-side refusal fallback on the models that take it, so a request Anthropic's safety classifiers decline is re-run on another Anthropic model instead of coming back empty (the answer's note says when that happened). The tests answer for api.anthropic.com themselves (`test/e2e/test_assistant_claude.py`, `test/assist.test.js`). It has not been run against the real API with a real key yet: the first run with one may need a small fix, and the raw reply is what to look at.

## Not here yet

Letting an assistant (a local model or Claude) act on a workspace (load, expand, follow the money in plain language) is not offered. It needs an approval step for every request first, shown before anything runs; see the roadmap.
