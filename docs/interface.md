# The machine-readable interface

Hopline's analysis can be read by a script or an AI assistant without the page: the same patterns, peel chains, change guesses and clusters the workspace shows, as plain JSON, with the reasons that go with them. It reads a file and prints; it never opens a connection.

The idea behind it: **the facts come from the analysis, never from a model.** A model is only given the evidence and asked to read it, rank it or put it into words, and every transaction id and address in its answer is then checked against the evidence.

## The command-line tool

Needs Node.js 18 or newer. `workspace.json` is a file made by **Export > JSON** in the workspace (`-` reads standard input).

```sh
node tools/hopline-cli.js summary    workspace.json
node tools/hopline-cli.js detections workspace.json [--kind peel|consolidation|batch|coinjoin|round|swap|omni] [--chain P-65a1]
node tools/hopline-cli.js chains     workspace.json
node tools/hopline-cli.js focus      workspace.json <transaction id | address | P-65a1 | C3>
node tools/hopline-cli.js prompt     workspace.json --task triage [--focus <ref>] [--max-rows 60] [--actions] [--json]
node tools/hopline-cli.js check      workspace.json answer.txt
node tools/hopline-cli.js actions    workspace.json answer.txt
node tools/hopline-cli.js trace      workspace.json [--ref <wallet or transaction>]
node tools/hopline-cli.js handoffs   workspace.json [--ref <wallet or transaction>] [--csv]
node tools/hopline-cli.js route      workspace.json --from <wallet or transaction> --to <wallet or transaction>
```

Options: `--known <file>` (the wallet list to name wallets with; the default is `public/data/known-addresses.js`, which is read as data and never run), `--packs <folder>` (the packs the site ships that are on as shipped, which is the OFAC sanctions list; the default is `public/packs`, read as data and never run), `--with <id,id>` (also use these shipped packs that are off as shipped, such as `ransomwhere`), `--no-packs`, `--no-known` (no names from either list), `--generated <ISO time>` (to make the output repeatable), `--compact` (one line of JSON), `--with-peers` (the relay peers that the first-seen look-ups recorded, in the `timing` block; left out by default).

`trace`, `handoffs` and `route` follow the money by what spent each coin, never by matching addresses, in the loaded transactions only. `trace` says where the trails meet a service wallet (from every starting point saved in the file, or from `--ref` when given: each row says which, `from`; `handoffs`: a deposit or a withdrawal, oldest first, with the wallet just before a deposit or just after a withdrawal) or passes a wallet that a sanctions or ransomware list names (a row of `kind` `named`, not a service: the trail goes on through it; `kind` is `service` otherwise, and your own labels and tags are not rows) and where it is still open (`openEnds`: outputs whose spend was never looked up, spenders and funders that are not loaded, the named wallets it ended at, what sits unspent). `handoffs --csv` is the same rows as CSV. **Who said a name.** Every row of `trace` and `handoffs` has a `source`: what the lists say about its service wallet, kept apart from the name the row shows (which may be your own label): `{ list, licence, attribution, asOf, url }`, or `null` when no list names the wallet (the built-in list is called *Built-in list* and says nothing about its licence). In the CSV the same five come after `start` as `source_list`, `source_licence`, `source_attribution`, `source_as_of` and `source_url`, empty when there is none. The columns that were there stay where they were. `route` prints the route and its steps, or `{ "route": null }` and exit code `1` when none was found in what is loaded (which only means none was found there). The reference is `--ref` (an address or a transaction id), else the first starting point saved in the file (a workspace made from a trace has one), else a wallet tagged THREAT. A service wallet is a name on the lists that is not a ransomware or sanctions entry, or a vertex tagged EXCH, MIXER, SERVICE, MARKET or GAMBLING; a route is not carried across one unless there is no other way, and then `acrossServiceWallets` names it.

Exit codes: `0` done, `1` `check` found an id that is not in the evidence, `actions` found no readable block or `route` found no route, `2` it could not run (the message is on standard error).

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
| `detections[]` | One per pattern per transaction, oldest first: `txid`, `time`, `kind` (`peel`, `consolidation`, `batch`, `coinjoin`, `round`, `swap`, `omni`), `pattern` (`PEEL 3/6`, `CONSOL 34→2`), `chain`, `step`, `of`, and `why`, the reason in words. |
| `chains[]` | Every possible peel chain: `label` (`P-65a1`, named after its first transaction), `txids` in order, `startedWithSats`, `endedWithSats`, `totalPeeledSats`, `continues`, and `payments[]` (`txid`, `vout`, `address`, `sats`, `passedOnSats`). |
| `clusters[]` | Addresses spent together as inputs of one transaction: `label`, `size`, the first `addresses` and `txids`. |
| `change[]` | Likely-change guesses of medium or high confidence: `txid`, `vout`, `address`, `sats`, `confidence`, `reasons`. |
| `wallets[]` | Wallets that carry a label, a tag or a note, or that the wallet list names: `address`, `label`, `tag`, `note`, `known`, `cluster`. `known` is `name`, `category` and `source` (the list that names the wallet), and, when that list says so about itself, `licence`, `attribution` (who to credit), `asOf` (the date of its data) and `url` (where to read the entry); `sanctions` and `alsoListedAs` when they apply. |
| `trace` | `null` without a reference, else how far the trail from it got: `referenceKind`, `reference`, `referenceName`, `startingPoints[]` (every place the trail was started from, often one for each case), `handoffs[]` (`kind` service or named, `direction` deposit or withdrawal, `service`, `serviceWallet`, `txid`, `time`, `sats`, `walletBeforeOrAfter`, `steps`, `mergesInputs`; `handoffsTotal` says how many there were before the cut) and `openEnds.next` / `openEnds.prev` (`count`, `sats`, `unchecked`, `notLoaded`, `resting`, `named[]`, `rows[]`: each `kind` (`unchecked`, `spent` or `funder`), `address`, `sats`, `txid` (the loaded transaction at the edge, or the one that is not loaded for a `spent` end) and `next` (the transaction that is not loaded, when it is another one than `txid`), `steps`). In a prompt the rows are named fields instead: `kind` is `spendingNeverChecked`, `spenderNotLoaded` or `funderNotLoaded`, with `loadedTransaction`, `outputToWallet` or `inputFromWallet`, `btc`, `notLoadedTransaction` and `steps`, and `openEndKinds` says what each kind means and what to do about it. |
| `timing` | `null` when there is nothing to say, else facts about when and how the transactions were made, none of them a finding (see [evidence-timing-and-habits.md](evidence-timing-and-habits.md)): `firstSeen` (`rows[]`: `txid`, `blockTime`, `firstSeen`, `sources`, `waitSeconds`, `group`, `relayRecorded`, and `relay` only with `--with-peers`; `expectedClosePairs`), `pairs[]` (transactions of different signing groups that are close in time: `txids`, `groups`, `why` (the same block with no wallet in common, or first seen within `windowSeconds`), `gapSeconds`, `firstSeenGapSeconds`, `height`, `trails` (the starting points of the trail each side descends from, found by following the coins forward) and `linksTwoTrails`, true when both sides descend from starting points and share none: the kind of pair that links two cases), `trailLinks[]` (those pairs gathered by the two starting points they connect, closest first, each with the transaction and the group that came from the first starting point (`fromStartingPointA`, `groupOfA`) and from the second (`…B`), and `habits`, the habits of those two groups compared (`comparable`, `rows`, `agree`, `agreeCommon`, `changeMatches`), or `comparable: false` with `thin` naming each group that has too few signed transactions, so that no one needs to borrow the comparison of two other groups; null when no transaction has a trail, so nothing is claimed), `sameBlock` (how many such pairs, and how many to expect by chance: `expected` is over all the loaded blocks together, never for one block, and the prompt says so beside the number in `expectedIs`), and `habits` (`groups[]`: for each signing group of at least three transactions, `signed`, `version`, `locktime`, `sequence`, `shape`, `fee` (the share of whole-number fee rates), `flags`, `hoursUtc` (24 counts), `changes[]` (where a habit changes and stays changed); `compare[]`: for two groups each habit is the same, different or **mixed** (a group with no single value, such as half version 1 and half version 2, is mixed and never counted as agreeing or differing), the settings most wallets use are marked `common`, and `changeMatches[]` lists a change of habit that both made the same way with the window each changed in and where the windows overlap; `trails`, `sharedStartingPoints` and `linksTwoTrails` say which starting points the two groups descend from, and a similarity between groups that share one does not link two starting points). Groups made only of wallets tagged VICTIM are left out of the pairs and the habits and counted in `victimGroupsLeftOut`; a group says the starting points it descends from (`trails`) and the tags of its wallets (`role`). Each pair also carries `considerations[]`, what limits it, written by code (the first-seen times come from different services, a side has no habit record). A first-seen time is a service's claim. A signing group is the owner the analysis gives the inputs of a transaction. |
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
- `ask`: answer your own question (`--question`, up to 1,000 characters) from the evidence. The question sits between `<<QUESTION` and `QUESTION>>`, as one line, and cannot close the evidence block. The `--focus` item and every transaction id, address, peel chain (`P-65a1`) or cluster (`C3`) named in the question are described in full (at most six), under `focus`; the rest is the usual cut-down evidence. The model is told to say what is missing when the evidence cannot answer.

Peel steps are listed once, inside their chain; the other patterns are rows, cut at `--max-rows` (the cut is stated in `limits`). A typical workspace comes to a few thousand tokens. Many local models read only about 4,000 tokens unless their context window is raised (in Ollama, `num_ctx`), and silently ignore the rest; the workspace warns when a prompt is larger than that.

## Checking an answer

`check` (and **Check ids** in the workspace) finds every transaction id and address in an answer and sorts them:

- **in the evidence**: it was in what the model was given;
- **loaded, not in the evidence**: it is in the workspace but was not among the evidence;
- **not in the workspace**: made up, garbled or from somewhere else. `ok` is false and the exit code is `1`.

A shortened id (`1f0849…c46ad`) is accepted only when it can be only one transaction. A paragraph that states an amount without citing any id is listed under `uncited` (a hint, not a failure). What the check cannot do is tell whether a sentence that cites a real id says something true about it: that still needs a person.

## Actions the model may propose

With **Let the model propose actions** ticked in the workspace's *Assistant* section (off by default), or `--actions` on `prompt` (and `--task next`, which asks for only the list), the prompt adds a short instruction and a format: after its answer the model may write one fenced JSON block, `{"actions":[{"action":"load","id":"<transaction id or address>","why":"<one sentence>"}]}`. The actions are `select` and `ring` (`ids`: up to 20 ids that are on the canvas), `load` (`id`: an id the evidence or the workspace names and that is not loaded yet), `follow` (`id`: a loaded transaction, `direction`: `forward` or `backward`) and `compare` (`groups`: two ids of two different signing groups). There is no action that asks a third party anything.

The block is read strictly and checked by code, never by the model. A block that is not JSON, an unknown action, a missing or too long `why` (200 characters), a malformed id, an id that neither the evidence nor the workspace holds (a made-up or garbled one), a vertex that is not loaded where one is needed, and any entry after the eighth are dropped with their reason; of several blocks the last is read. With no fenced block, the last bare JSON object that starts with `"actions"` is read, as strictly. The workspace shows what is left as a checklist: each line is written by Hopline from the fields, the model's `why` is shown apart as "the model says", and **nothing runs until a person presses Apply** (or *Apply all*, which first says how many requests the loads would take). A load or a follow is a load like any other: the data source you chose, the request limit, *Undo load* and an entry in the activity log. A comparison shows as a card under its row and in the Findings, and is not saved in the file. A `load` of something that is already loaded (a model's way of saying "show me it") is not dropped: all of them become one `select` row, worded by Hopline, with a note that says so.

`node tools/hopline-cli.js actions workspace.json answer.txt` does the reading and the checking without the page and prints `{ found, error?, blocks, actions: [{ n, action, why, text, ... }], dropped: [{ n, reason }] }`; the exit code is `1` when there is no readable block.

## A model on this computer

The workspace can ask a model for you. The address must be on this computer (`localhost`, `127.0.0.1` or `::1`); anything else is refused, so the evidence never leaves the machine, and no key is ever sent. It speaks the OpenAI chat format (`POST /v1/chat/completions`), which Ollama, LM Studio and the llama.cpp server all offer. **Test connection** asks the server which models it has (`GET /v1/models`; no evidence is sent) and offers them in a drop-down under the Model box, which stays a text box. If the browser blocks the request, allow the page's address in the server (for Ollama, the `OLLAMA_ORIGINS` setting).

The reply is shown in an editable box labelled as a model's draft, and its ids are checked at once. A reply is never added to the graph or to a report by itself.

This part is tested against a stand-in server that behaves like those servers, and has been run against a real model (`gpt-oss:20b` on Ollama). To ask several models the same questions and score what they answer by code (invented ids, answers cut off, the block of actions, phrases you expect), see [model-comparison.md](model-comparison.md): `node tools/compare-models.js`.

## No hosted models

The workspace asks only a model on this computer. There is no option that sends the evidence to a hosted service and no box for an API key: an earlier version had an optional one for Anthropic's Claude, and it was removed so that "the evidence never leaves your computer" has no exception. `test/tools/test_local_only_assistant.py` and `test/e2e/test_assistant_local_only.py` fail if one is added.

To use a hosted assistant anyway, take the text yourself: *Copy for assistant* (or `node tools/hopline-cli.js prompt`) gives the instructions and the evidence, and you decide where to paste them. Paste the answer back into the answer box and press *Check ids*; it is checked like any other. What a hosted service does with the text is set by your agreement with it, not by Hopline.

## Not here yet

Letting an assistant (a local model) act on a workspace (load, expand, follow the money in plain language) is not offered. It needs an approval step for every request first, shown before anything runs; see the roadmap.
