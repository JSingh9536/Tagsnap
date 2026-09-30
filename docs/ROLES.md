# Drivers, Subhaulers, and Who Gets Paid

The app asks "Driver or Subhauler?" before it asks anything else. This document
is why, and what turns on the answer.

---

## 1. The two are different financial instruments

They look the same from the cab — someone photographs a scale ticket after
pulling off the scale. They are not the same at all once the ticket reaches the
office:

| | Company driver | Subhauler |
|---|---|---|
| Who they are | Your employee | An outside outfit hauling for you |
| Whose truck | Yours | Theirs |
| What they get | A **driver settlement** | An **accounts payable invoice** |
| Which system it lands in | Payroll | AP |
| Rate comes from | Your driver pay schedule | A negotiated hauling agreement |
| Rate is scoped to | The individual | The **outfit**, not the person driving |

The last row is the one people get wrong. A subhauling outfit may put three
different drivers in three different trucks over one week. You do not owe those
three people anything — you owe **Ridgeline Trucking**, once, for the tonnage
its trucks moved. So the payee is the outfit, and the individual behind the
wheel is only who filed the ticket.

Mixing those two on one document is not a cosmetic problem. It means a payroll
run containing a vendor payable, or a 1099 vendor sitting in a payroll export.

---

## 2. How the split is enforced

Not by asking nicely in the app. Three layers, each of which holds when the one
above it is bypassed:

**The `payee_type` column.** Every tag carries `employee_driver` or
`subhauler`, and a check constraint requires the matching id to be populated:

```sql
constraint payee_target_is_consistent check (
  (payee_type = 'employee_driver' and subhauler_id is null)
  or (payee_type = 'subhauler' and subhauler_id is not null)
)
```

A subhauler tag with no outfit on it cannot be written. Not by the app, not by
a script, not by hand in the SQL editor.

**The insert policy.** A field user may only file a tag whose payee matches
what they actually are:

```sql
and case app.current_role()
      when 'subhauler' then
        payee_type = 'subhauler' and subhauler_id = app.current_subhauler()
      when 'driver' then
        payee_type = 'employee_driver' and driver_id = auth.uid()
      else app.is_office()
    end
```

A driver cannot bill a load to a subhauler to inflate its value, and a
subhauler cannot file one against the employee ledger. Since this is an RLS
policy rather than a check in the mobile app, it holds against a raw API call
with a stolen token.

**The rate table.** `rates.payee_type` is `not null` and is never a wildcard,
with a constraint that a row scoped to a driver cannot also be scoped to a
subhauler. An employee rate can never price a subhauler load even if every
other column matches.

**Invoices.** One invoice, one payee. `invoice_payee_is_consistent` makes an
invoice with both a `driver_id` and a `subhauler_id` unrepresentable.

---

## 3. What the portal picker actually does

The sign-in screen offers Driver and Subhauler. **This is a UI affordance, not
a permission.**

If picking "Subhauler" granted subhauler access, the picker would be a
privilege escalation — anyone could choose "Office" and start approving
payments. So the flow is:

1. The user picks a door. That decides which sign-in screen they see and which
   colour the app runs in.
2. They authenticate.
3. The client asks the server who they are — `profiles.role`.
4. If the answer disagrees with the door, they are signed back out and told
   which one to use.

See `reconcilePortal` in `apps/mobile/src/state/auth.tsx`. The real
authorisation is `profiles.role`, set by an admin, enforced by RLS on every
query regardless of what the client believes.

Office and admin accounts are turned away from the mobile app entirely. That is
deliberate: their work is the review screen, which needs a wide layout and a
photo big enough to read a faded carbon copy on. Letting them sign in on a
phone would hand them an app that cannot do their job.

---

## 4. What each role can see

| | Own tags | Others' tags | Rate table | Approve |
|---|---|---|---|---|
| `driver` | yes | no | **no** | no |
| `subhauler` | yes, plus their outfit's | only their outfit's | only their own outfit's rates | no |
| `office` | all in company | yes | yes | yes, except tags they filed |
| `admin` | all in company | yes | yes + edit | yes, except tags they filed |

Two of these are worth spelling out.

**Subhaulers see their outfit, not just themselves.** If Ridgeline puts two
drivers on the road, either can see both of their loads, because Ridgeline is
the party being paid and needs to reconcile its own invoice. The policy keys on
`subhauler_id`, not on `auth.uid()`.

**Two subhaulers never see each other.** Tonnage and rates are competitive
information between outfits that may bid against each other. The policy makes
that structurally impossible rather than a matter of building the right screens.

**Drivers cannot read the rate table at all.** Not a UI omission — there is no
select policy that admits them.

---

## 5. Separation of duties

A tag's submitter cannot approve it. Enforced twice, on purpose:

```sql
-- the constraint
constraint approver_is_not_submitter
  check (approved_by is null or approved_by <> created_by)

-- and again inside approve_tag()
if t.created_by = actor then
  raise exception 'separation of duties: you cannot approve a tag you submitted';
end if;
```

The constraint is the one that matters — it is the layer that survives someone
calling the API directly. The check inside the function exists to produce a
sentence a person can act on rather than a constraint violation.

This bites in one legitimate case: an office user who photographs a tag
themselves cannot then approve it. That is the rule working. Someone else
approves it.

---

## 6. Open questions this design does not answer

These come from `Trucktags/docs/ARCHITECTURE.md` section 11 and remain open.
The schema is shaped to absorb the answers without a migration where possible:

1. **Is subhauler pay ever a percentage of the load's revenue** rather than a
   flat rate per ton? `rate_unit` covers ton, load, and hour. A percentage
   model needs a fourth unit and a revenue figure the system does not currently
   hold.
2. **Do subhaulers submit their own invoice** that we reconcile against, rather
   than us generating one? That is a reconciliation workflow, and it would
   reuse the quarry-invoice matching described in
   `Trucktags/docs/INGESTION.md` tier 4.
3. **Fuel surcharge.** If it applies to subhaulers and not employees, it is
   another rate row, not a code change. If it is a percentage adjustment on top
   of the line, it needs a column.
4. **What is a pay period**, and is it the same period for both books? Weekly
   settlements with monthly AP is common, and would mean two close cadences
   rather than one.

Tax identity data stays out of this system in every scenario. If 1099 handling
is needed, it belongs in the accounting system — the cheapest way to secure
sensitive data is to not store it.
