# The TagSnap AI company

An "org" of AI roles that runs TagSnap: a CEO who sets priorities, a product lead who writes specs, and
function leads for security, legal, finance, marketing and people. It runs on the same swarm engine and the
same safety rules as the engineering team — local, on your Claude plan, guarded on every tool call.

**Nothing here acts in the world.** Every role is read-only and produces a *draft memo*. No money moves, no
one is hired, no customer data changes, nothing is published or sent. A human reads the memos and decides.

## The roles (`company/agents/`)

| Role | Writes |
|---|---|
| `ceo` | the one-page cycle plan: the three outcomes, trade-offs, assignments |
| `product-lead` | a spec with testable acceptance criteria for the top outcome |
| `security-lead` | a risk memo; owns customer-data protection and drives `swarm audit` |
| `legal-counsel` | data/privacy, terms, dependency-license and IP-ownership memo (not legal advice) |
| `finance-ops` | unit economics, pricing options, cost of running |
| `marketing-lead` | positioning, landing copy, launch/changelog notes |
| `people-ops` | proposes new roles, rubrics, and keeps this runbook current |

`ceo` and `product-lead` run first, in order; the five function leads then run in parallel, each reading the
plan and spec.

## Run a cycle

From the swarm checkout (so the `swarm` CLI is on PATH):

```powershell
swarm company "ship offline ticket capture with sync" --project E:\projects\TagSnap --nice
```

- `--nice` keeps it at low CPU priority so you can keep using the PC.
- Leave the focus off to let the CEO choose from the repo state.
- `--model haiku` runs the whole cycle cheaply; the default is a balanced mix on your plan.
- `--dry-run` shows what would run without starting anything.

Output lands in `company/`: one `<role>-<date>.md` memo per role, plus `board.md` indexing the cycle. The
run's own log and transcripts are under `.swarm/runs/<id>/` (git-ignored).

## Then what

1. Read `company/board.md` and the memos.
2. Approve the CEO's outcomes and the product spec.
3. Hand the spec's one-line task to engineering: `swarm run "<task>" --project E:\projects\TagSnap`.
4. Re-run `swarm company` next cycle — it reads the prior memos and the swarm's own `.swarm/lessons.md`, so
   the org improves over time.

## Safety

Read-only roles, guard hook on every tool call (no `git push`, no outbound shell network, no reading `.env`
or other secrets, no writes outside the project or into `.swarm/`), and on-plan billing that stops before it
would spend outside your plan. The memos are drafts; you are the only one who acts on them.
