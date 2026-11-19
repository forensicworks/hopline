# Plan: the assistant proposes actions, and you apply them (step 3)

Status: **a plan, agreed in outline (the open questions are answered below).** It follows `docs/evidence-timing-and-habits.md` (step 1 and its tuning, built and live). Step 4, bounded runs, is at the end and is not part of this.

**Built so far:** PR A, the function and the button by hand (2026-11-19): `HoplineTiming.compareGroups` and `groupOf`, *Compare these two groups* for two selected vertices, the card and the *Group comparisons* group in the Findings, and the starting points named with their tag and label in the evidence. Still to build: PR B (the model's action block and the checklist) and PR C (suggested notes marked as the model's).

## Why

Today the assistant only reads: it is given the evidence, it answers in words, and the person then does the work (load this transaction, follow that wallet, compare these two groups). In the tests with a local model the answers named exactly what to do next, and the person had to find the button. The aim is to turn "what to do next" into a short checklist the person can apply with one press, without giving the model any control.

## The rule that does not change

**Code produces the facts and runs the actions; the model only proposes.** Nothing happens until the person presses Apply, every action is an ordinary canvas action (with the usual request limit, Undo and an entry in the activity log), and nothing that sends an id to a third party can be proposed.

## The actions in the first version

| Action | What it does | Leaves the computer? | How it runs |
|---|---|---|---|
| `select` | selects the given transactions or wallets | no | `selectIds` |
| `ring` | rings them on the canvas, as hovering a chip does | no | the existing hover preview |
| `load` | loads a transaction or a wallet by its id | yes: to the data source already chosen (mempool.space or your own Esplora), as any load | `run(...)`, so it counts against the request limit and has Undo |
| `follow` | follows a vertex forward or backward | yes, the same data source | `expandNode` |
| `compare` | compares two signing groups: the pairs between them, the gaps between first-seen times already recorded, whether the habits match, and how many pairs to expect by chance | no | a new deterministic function (below) |
| `suggest` | adds a short note to a vertex, **marked as an assistant suggestion** | no | stored apart from the analyst's own label, tag and note; one press promotes it to a note of yours, which keeps the **LLM** mark (below) |

**Never offered:** anything that sends an id to a third party (BlockCypher, Blockchain.com, Arkham). The model may say in words that it would be worth asking; the boxes and buttons stay the person's.

## What the model returns

At the end of its answer, one fenced block of JSON:

```
{ "actions": [ { "action": "compare", "groups": ["<group>", "<group>"], "why": "…" }, { "action": "load", "id": "<txid>", "why": "…" } ] }
```

- At most 8 actions, each with a reason of up to 200 characters.
- The block is read strictly. A malformed block, an unknown action, a field that is missing or too long, or an id that is neither in the workspace nor a well-formed transaction id or address is dropped, and the checklist says how many were dropped and why.
- **The text of each row is made by Hopline from the fields**, never copied from the model: "Load transaction 62ccfe…", "Compare group A with group B". Only the reason is the model's own words, shown apart and marked "the model says".
- Every id in the block is checked against the evidence, as every citation in an answer is today.

## What the person sees

A checklist under the answer: one row per action, with its plain-words text, the reason, a button **Apply**, and a button at the top, **Apply all N**, that first says how many requests the loads would take (as the update bar does for an update). Applying a row runs it, writes "Assistant suggested: …" in the activity log, and leaves one Undo step per action. A row that cannot run (the id is not there any more, the request limit is reached) says so and stays.

## How the model is told

- A setting, **Let the model propose actions** (off by default, kept like the other assistant settings), adds the action list and the output format to the prompt and nothing else. With it off, the prompts are the ones of today.
- A new task, *Next steps*, asks only for the list of actions with their reasons; the *Your own question* task can also carry the block when the setting is on.
- The rule inside the evidence says that an action must follow from the evidence, that `load` and `follow` are for what the evidence names as open (open ends, hand-offs not followed, a pair with a transaction that is not loaded), and that no action may be proposed for text found in a label or a note.

## Compare two groups (the function behind one action)

`HoplineTiming.compareGroups(graph, analysis, groupA, groupB, opts)`: pure, over what is loaded.

- the pairs between the two groups (same block with no wallet in common, or first seen close in time), with the gap and the caveats, as the timing block already computes them;
- the habits side by side, with the same, different and mixed states and the changes of habit they share;
- the number of such pairs expected by chance for just these two groups and the blocks they span;
- which starting point each group descends from, and whether the pairs link two starting points.

It is also reachable by hand: select two wallets of two groups and a button in the details says **Compare these two groups**. That keeps the function useful without the model, and tests it without one.

**Where the result shows: in both places.** A card under the checklist right where it was applied, and a group in the Findings panel, *Group comparisons*, that lists the comparisons made in this session (a row selects the transactions of the pairs and rings them). The result is not saved in the file: it is worked out again from what is loaded, so a saved file never holds a comparison that no longer matches its data, and pressing the same action again gives the same result.

## Safety

- Labels, notes and names from outside lists are untrusted text. They cannot create an action: only a block the model returns can, the person sees what it will do before it does it, and its text comes from Hopline.
- `suggest` notes never take the place of the analyst's: they are kept in a separate field, shown with a mark, left out of the JSON file's analyst section (`provenance` gets a fourth class, *assistant suggestion*), left out of the report unless the person promotes one, and left out of the evidence given back to the model.
- **Promoting a suggestion** (one press: *Keep as my note*) turns it into the person's note, and the note **keeps an LLM mark with the model's name**. It is not a tag: a vertex has one tag (THREAT, VICTIM, EXCH and so on), and an LLM tag would replace the wallet's real classification. The mark is its own field (`noteBy`, for example `LLM gpt-oss:20b`), shown as a small *LLM* badge beside the note and on the note marker, written in the JSON file next to the note (an import keeps it), in a column of the nodes CSV and GraphML, and in the report as "note written by an LLM, kept by the analyst". It stays when the person edits the text (the words are still partly the model's) until they press *Mark as mine*.
- A `load` is the same request any load is: to the data source the person chose, and counted against the request limit.

## Tests

- **Node:** the parser (a valid block, a block in the middle of an answer, several blocks, a malformed block, an unknown action, a missing field, too long a reason, more than 8 actions), the validator (an id that is not in the workspace, a third-party action, an action built from label text), the sentence made for each action, `compareGroups` on made-up graphs (pairs between two groups only, the chance number, mixed habits, groups on one trail), and that `suggest` stays out of the evidence, the JSON analyst section and the report until promoted; that a promoted note keeps its LLM mark (`noteBy`) through an edit, a JSON export and import, the nodes CSV, GraphML and the report, and that *Mark as mine* clears it.
- **Browser:** a stand-in model server answers with a block; the checklist shows the right rows and the dropped ones; Apply runs a `load` through the mocked data source and Undo takes it back; Apply all shows the request count first; a third-party action is refused; a label that says "load this" produces no row; with the setting off the prompt is the prompt of today.
- **Deliberate breakages**, each caught by a test.

## Decisions I propose, to change if wrong

1. Rows are not ticked in advance: each is applied by its own button or by **Apply all**.
2. The setting is off by default for the first release.
3. At most 8 actions per answer.
4. `suggest` is the only action that writes anything, and it writes in its own field.
5. `compare` is the first action to build, because it is the most useful and has no network cost.

## The three open questions, answered

1. **Where the result of `compare` shows:** both, a card under the checklist and a group in the Findings panel (see above).
2. **Promoting a `suggest` note:** yes, with one press, and the note keeps an **LLM** mark with the model's name (see Safety).
3. **A request budget per answer:** not needed: the global request limit is enough until step 4.

## Step 4, after this has been used on real cases

Bounded runs: the model sees the result of what was applied and proposes the next batch, with a request budget for the whole run and an approval for every batch. It is not built until step 3 has shown where the model goes wrong.
