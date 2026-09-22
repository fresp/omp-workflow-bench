# readyset-bench

An end-to-end benchmark comparing omp's native **`/plan`** with the **`/readyset`** extension. It
covers the whole path from a feature request to executed, tested code:

```
feature request + repo state ──► preparation (plan | grill → explore → propose) ──► approval ──► execution ──► graded result
```

Both arms run the same model on the same request, in the same repository snapshot, with the same
simulated user answering their questions. The workflow is the only thing that differs.

## Quick start

```bash
./preflight.sh                 # checks omp, models, the extension and the task set. Changes nothing.
./run.sh T01 --reps 1          # one task, one rep, both arms: sanity check the real thing
./run.sh                       # full matrix (resumable: re-run with --label <label> after an interruption)
./compile.sh                   # grade every run → bundle.md per run + compiled.csv
./bench.sh                     # blind LLM judging + results/<label>/report.md
./insights.sh                  # improvement digest → results/<label>/improve.md (reads only, no LLM calls)
node harness/calibrate.mjs export   # optional but recommended before publishing: human-check the judges
```

Configuration is split across two files:
- **`models.txt`** lists the models under test, one per line.
- **`bench.config.json`** holds reps, parallelism, timeouts, the simulated-user model, judge
  models and the path to the readyset extension.

A run is written to `results/<label>/`, where the label is a timestamp unless you pass `--label`.

## What's in the box

| Path | What |
| --- | --- |
| `fixtures/` | Three small, realistic, zero-dependency Node projects: `shoplite-api` (HTTP API), `taskflow-cli` (CLI), `ledger-lib` (library). Each has conventions in its README, seams to reuse, and a green test suite. |
| `tasks/T01…T12/` | 12 change requests, 4 per fixture (details below). |
| `tasks/*/request.md` | The only text either workflow receives. |
| `tasks/*/persona.md` | Private facts the simulated user answers from, and only when asked. |
| `tasks/*/acceptance.md` | Ground truth for the judges. The workflows never see it. |
| `tasks/*/hidden-tests/` | Tests copied into the final code after the run. They are the objective score. |
| `tasks/*/reference/` | A reference solution. Used only to prove the hidden tests are satisfiable. |
| `harness/` | Drivers, grading, judging, reporting. |
| `rubric/` | Prompts for the simulated user and the two judges. |
| `scripts/validate-tasks.mjs` | Proves every task is well-formed: hidden tests fail on the base, pass on the reference, and the fixture's own suite stays green. |
| `scripts/smoke-offline.sh` | Runs the whole pipeline against a fake omp and a fake LLM (no tokens spent). |

### The tasks

| ID | Fixture | Category | Clarity | Hidden tests |
| --- | --- | --- | --- | ---: |
| T01 Sort products | shoplite-api | feature-small | clear | 7 |
| T02 Coupon codes | shoplite-api | feature-multi-file | partial | 12 |
| T03 Discount rounding bug | shoplite-api | bugfix | clear | 5 |
| T04 Rate limiting | shoplite-api | feature-ambiguous | ambiguous | 9 |
| T05 Task priorities | taskflow-cli | feature-small | clear | 8 |
| T06 Storage repository + atomic writes | taskflow-cli | refactor | clear | 6 |
| T07 Recurring tasks | taskflow-cli | feature-ambiguous | ambiguous | 12 |
| T08 Storage v2 + migration | taskflow-cli | migration | clear | 8 |
| T09 CSV quoting bug | ledger-lib | bugfix | clear | 9 |
| T10 Monthly report | ledger-lib | feature-ambiguous | ambiguous | 6 |
| T11 Rename `post()` → `record()` | ledger-lib | refactor-cross-cutting | clear | 6 |
| T12 Fast balances | ledger-lib | performance | partial | 4 |

Clarity levels:
- **Clear:** the request specifies the interface and most behaviour. The persona adds only one or
  two details a careful engineer would still check (legacy data, input case, ties).
- **Partial:** the interface is given, but important semantics are not (rounding, caps, expiry).
- **Ambiguous:** a one-line request. Most of the behaviour lives in the persona, and a workflow only
  gets it by asking or by reading the code. This is where requirement elicitation is measured.

Hidden tests exercise the public interface that the request names (routes, CLI flags, exported
function names). Behaviour that only the persona knows is tested as behaviour. So a workflow loses
points for guessing semantics wrong, never for picking a different internal file name.

## How a run works

Each run is one cell: task × model × rep × arm. It starts from a fresh git repo copied from the
fixture, committed as `base`, in `workDir` (default `/tmp/readyset-bench-work`). The workspace sits
outside this directory so the agent can't wander into `tasks/` and read hidden tests.

Both arms are driven over `omp --mode rpc` with:
- `--no-extensions` (readyset loads its own extension with `-e`)
- `--no-skills`
- a per-run `--config` overlay that turns memory, autolearn and advisor off, so no run learns from
  another. `~/.omp/agent/config.yml` is never edited.
- a sandbox (`bwrap`): the agent sees only its workspace plus the cell's own output dir — the
  overlay, the staged extension and the session dir — bound read-only at `/run/cell`. The bench
  root, `tasks/`, other cells and other labels are not mounted.

**`/plan` arm** runs `omp --plan-yolo --plan-yolo-into <model> --model <model>` with the request as
the prompt:
1. The agent plans in read-only plan mode. Questions it asks through the `ask` tool are answered by
   the simulated user.
2. The approved plan is auto-accepted, the same as pressing Approve, and autosaved. That autosaved
   file is the arm's preparation output.
3. The agent then implements the plan in the same session.

**`/readyset` arm** runs:
1. `/readyset --model <m> --idea '<request>'`. Grilling runs, and its questions (plain chat in RPC
   mode) are answered by the simulated user. Grilling ends when the brainstorm file is written.
2. `/readyset --fast --model <m>`, which picks that brainstorm → Explore → Propose → review gate.
3. At the gate, the driver snapshots proposal, design, specs and tasks (the preparation output),
   then chooses **Approve & Execute**.
4. Apply runs, followed by the verification send-back (the tool's default option), then code review,
   then "Not yet" for archiving.

**Models.** Each line of `models.txt` is used for planning and execution in both arms, so the
comparison is workflow against workflow. The `@config` line instead runs each arm exactly as
`~/.omp/agent/config.yml` configures it:
- interactive `/plan` plans with `modelRoles.plan` and executes with `modelRoles.default`
- `/readyset` pins `readyset.model.default` for every turn

Treat `@config` as an "out of the box" secondary comparison, not the fair one. Each run records
omp's `routedModels`, so the report flags any run where a fallback model was used.

**Simulated user.** A small model is given the request, the persona and a few general facts (solo
developer, commit-only git, no CI). Its rules:
- answer only what is asked, from the persona
- never volunteer an unasked fact
- say "no preference" to anything the persona doesn't cover
- approve when asked to approve

Every exchange is logged in `sim-user.ndjson`. Both arms get the same user, so asking good
questions is rewarded the same way for both.

**Stopping rules.** A run ends when the workflow finishes (for /plan: idle after the plan is
approved and the last message isn't a question; for /readyset: after the archive prompt), or on the
time limit (`limits.runMinutes`). If an agent stalls without asking anything, it gets a neutral
nudge ("Please continue." / "Please write the brainstorm file now." / re-running `/readyset`), up
to `limits.maxNudges`. Nudges are counted and reported.

## What is measured

**Objective, from `compile.sh`:**
- **hidden-test pass rate** (the headline number), and **solved** (all hidden tests pass)
- the repo's own suite green
- code files and lines changed
- files touched outside the task's expected scope
- code changed before approval (a planning phase is supposed to be read-only). For readyset, a run
  whose review gate was never reached but whose product code changed is marked **`gate-bypassed`**:
  it still gets a hidden-test score, but it is flagged in the headline because it breaks readyset's
  "no execution without approval" guarantee
- **plan grounding**: file paths the plan mentions that neither exist in the repo nor get created
  (dangling)
- questions answered by the user, and nudges
- wall time and tokens, both split into prep (start → approval) and exec (approval → end); tokens
  are also split into fresh input, cache read and output, because cache reads are much cheaper
- **grading is rebuilt from `final/changes.diff`** on a fresh copy of the fixture, never from the
  live workspace (which can be cleaned or clobbered)

**Token accounting (one canonical definition).** A run's token cost is the sum, over
**deduplicated assistant messages**, of `usage.input + usage.cacheRead + usage.cacheWrite +
usage.output` (i.e. `usage.totalTokens`), taken from `rpc.ndjson`. `cacheWrite` is included — it is a
real billable prefill on providers that report it (it is always `0` here). Compaction summaries that
omp emits as `role: "compactionSummary"` are **not** assistant messages and are excluded; the tokens
spent *producing* the summary are counted, because they appear as assistant messages.
`message_start`, `message_end` and `turn_end` repeat the same usage object, so frames are
deduplicated by `message.responseId` (else a hash of timestamp + usage) — otherwise the total
triples. omp's `get_session_stats` client totals are recorded (`tokensClientTotal`) but **not used
for reporting**: that counter resets when the context is compacted mid-run, so it undercounts long
runs and `subtractTokens(final, prep)` can go negative for exec. `scripts/check-tokens.mjs` compares
the two per run and warns when they differ by more than 2% (`--strict` to fail). For a run that
never compacts (`/plan`) they agree exactly.

**TODO — subagent (`task`) tokens are not accounted for.** When a run spawns a subagent via the
`task` tool, the subagent's own reasoning happens in a separate session; its tokens appear nowhere in
the parent's `usage` frames and so are missing from every per-run total here. The parent is charged
only for the tokens it spends reading the echoed `<task-result>` text. This matters only for runs
that call `task` (5 calls across v0.12, all in readyset/plan runs that delegate a sub-step); until
the accounting is closed, treat such runs' token totals as a lower bound.

**Judged, from `bench.sh`.** Pairwise and blind, run separately on two things:
- **plan**: the preparation documents, normalized so tool vocabulary like "readyset", change-dir
  paths and "plan mode" is removed
- **code**: the code-only diff, with workflow artefacts excluded

The judges get the request, the ground truth (`acceptance.md`) and the base repository — including a
plain list of the file paths present at base, so a judge does not penalise a plan for citing a real
file it believes was invented. Each judge model sees every pair twice, with A/B positions swapped. A
dimension counts as a win only when both orders agree; otherwise it's a tie. The report shows
position consistency per judge and agreement between judges. Judges are told not to reward length or
structure. The rubrics are in `rubric/`.

A verdict is **valid** only if the top-level `overall` and every dimension is exactly `A`/`B`/`tie`
and every dimension the rubric's `DIMENSIONS:` line names is present. An invalid verdict is retried
up to `judge.retries` times, then recorded with `status: "invalid"`; the console prints
`ok`/`retry`/`invalid` and never reports a malformed verdict as `ok`. Invalid verdicts are excluded
from win rates and counted under Run health as `invalid judge verdicts: N`.

**Judge coverage.** A judge that produced far fewer verdicts than the best-covered one was run in a
different invocation (a label judged twice with different rosters). Judges below
`judge.coverageFloor` (default 0.9) lose their per-judge row and are dropped from the inter-judge
agreement figure; Run health names them and their coverage. `bench.sh` refuses a second judging
invocation on a label whose `judgments/` already holds a *different* roster, unless `--force`.

Swapping positions does not control for **length**, and LLM judges tend to favour longer documents.
The report therefore has a *Verbosity check* table: each task's planning-document length ratio next
to its planning verdict. Read the planning win rate together with it. For a stronger control, run
`./bench.sh --length-matched`: each planning document is summarised to a fixed character target
(`judge.lengthMatchChars`, default 8000) with one call per document (cached by document hash) before
judging, and the report prints the raw and length-matched win rates side by side.

A verdict is reused only if it was made on exactly the same documents (hashed); recompiling a run
so that a document changes makes `bench.sh` judge that pair again. For a readyset run that never
reached the gate, the planning document is recovered from the final tree (including
`readyset/changes/archive/`) and labelled as such.

**Statistics:**
- **Comparison set:** only tasks where both arms have a valid run. Both arms' means are taken over
  that same set, and the report names the excluded tasks.
- **Harness errors** (the benchmark failed, not the workflow) are never dropped silently: they are
  listed under Run health, excluded from the paired comparison and from judging, and scored 0 in a
  separate **intent-to-treat** line, which is a worst-case lower bound.
- Results are paired by task: readyset − plan, averaged over models and reps.
- 95% confidence intervals use a cluster bootstrap over tasks (tasks are the unit that generalises).
- An exact sign test runs over the per-task deltas.
- Judge win rate is (wins + ½ ties) / comparisons.

## Two-tier benchmarking

**Quick check — after each wave of readyset changes.** Run the subset the wave touches on the lanes
those tasks should use, then gate on `quick-check.md`:

```bash
./run.sh T03 T04 T09 T11 --arms readyset-fast,readyset-full --reps 1 --label wave-7
./compile.sh --label wave-7 && ./bench.sh --label wave-7
./quick-check.sh --label wave-7 --baseline v0.12   # → results/wave-7/quick-check.md
```

`quickCheck` in `bench.config.json` holds the criteria (per-task hidden drop, must-improve tasks,
expected lanes, clear-task wall-time drop, dangling refs, protected paths, user-edits-preserved,
T03 code judge, review skip rate). It is a fast smoke gate, not a score: it compares a few tasks to a
baseline label's readyset arm and prints pass/fail per criterion.

**Full matrix — before a release or any public claim.** All tasks, ≥3 reps, both lanes, the judges,
and the caveats in "Before you publish numbers". Quote `report.md` with its `run-manifest.json`.

**Lanes.** readyset's arms are `readyset-fast`, `readyset-full` and `readyset-auto`; `--lane auto`
omits the flag and lets the brainstorm's recorded lane decide (the effective lane and its source are
recorded per run). The report has *By lane* and *Phase outcomes* tables, built from readyset's own
`<!-- readyset-phase -->` events in each change's `CONTEXT.md` (readyset ≥ 0.13; older runs render
"—").

## Before you publish numbers

0. Run each label from **one** process. `run.sh` takes a lock (`results/<label>/.lock`) and refuses
   to start while another live process holds it; two processes on one label share workspaces and
   destroy each other's repos.
1. Run `./preflight.sh`, then `./run.sh T01 --reps 1` and open the two `bundle.md` files by hand.
   Confirm each arm really went through its whole flow (check `metrics.json` → `events`).
2. Run the full matrix with at least 3 reps (`runsPerCell`).
3. Calibrate the judges: `node harness/calibrate.mjs export --n 12`, review the blind pairs, fill in
   `verdicts.json`, then `node harness/calibrate.mjs score`. With kappa below about 0.6, trust the
   hidden tests and treat the judge numbers as indicative.
4. Publish `report.md` together with this repository, `results/<label>/run-manifest.json` (omp
   version, readyset commit, configs) and the per-run bundles, so anyone can re-grade.

## Known limitations

- **12 tasks on small fixtures.** Real repositories are larger and messier. Grounding pressure is
  lower here than in production code.
- **Built by readyset's author.** The tasks were written with the reference solutions in mind,
  before either workflow was run on them. The hidden tests, personas and rubrics are published so
  anyone can check the fairness.
- **Simulated user vs. a real one.** An LLM playing the user is more consistent than a person, and
  may be more or less forthcoming. The persona rules try to hold it to "answer only what's asked".
- **Different interaction surfaces.** Headless, `/plan` asks through omp's structured `ask` picker,
  while readyset's grilling falls back to plain-chat questions (RPC has no `askDialog`). Both reach
  the same simulated user, but the surfaces differ from interactive use.
- **The readyset arm receives the request through `--idea '…'`.** The text is passed verbatim,
  line breaks included. The only change is that single quotes inside it become ’, so they survive
  readyset's argument parser.
- **Planning output excludes exploration notes.** For readyset, the judged preparation output is
  the requirements record, proposal, design, specs and tasks; `EXPLORATION.md` is left out. For
  /plan it's the approved plan file. Neither arm's exploration transcript is judged.
- **A readyset bug was fixed because of this benchmark.** The first full run (omp 18.2.0,
  readyset 0.11.1) showed that under omp's RPC host the review gate was silently discarded, so
  the /readyset arm never executed. That is a host-compatibility bug, not a task-specific tweak;
  it was fixed in readyset 0.11.2 before any readyset result was scored. Each run records the
  readyset version and commit in `run-manifest.json`.
- **First run (`deepseek-r1`) was contaminated.** Two `run.sh` processes ran the same label at once
  and deleted each other's workspaces; three readyset cells (T03, T06, T07) were lost as harness
  errors, and several others may have been affected. The label lock now prevents this; that run's
  numbers should not be quoted.
- **Timing and tokens** depend on provider load. Arm order alternates per rep to spread the drift.
