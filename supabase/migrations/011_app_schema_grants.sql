-- TagSnap — 011 lock down the app schema
--
-- Found by pushing 001-010 to a real database for the first time and then
-- looking at what a signed-in driver can actually reach.
--
-- `grant usage on schema app to authenticated` in 002 is necessary: RLS policy
-- expressions are evaluated as the calling user, so the six helpers those
-- policies call have to be callable by that user. What was missed is that
-- Postgres grants EXECUTE on *every* new function to PUBLIC by default, and
-- `authenticated` inherits PUBLIC. Schema USAGE plus a default PUBLIC grant
-- means every function in `app` was callable by every signed-in user.
--
-- Most of them are harmless. Three are not:
--
--   app.config(text)              SECURITY DEFINER over app_config, which
--                                 holds `service_role_key` — the key that
--                                 bypasses every policy in 002. A driver
--                                 calling app.config('service_role_key') gets
--                                 read and write access to every company's
--                                 pay records.
--   app.sweep_unread_tags()       SECURITY DEFINER, moves tags to
--                                 needs_review. Not a data leak, but any
--                                 client could churn the office's queue.
--   app.match_rate(...)           SECURITY DEFINER, returns any company's rate
--                                 row for arbitrary arguments.
--
-- How exposed was this in practice? Less than it sounds, and it is worth being
-- exact rather than dramatic. PostgREST only exposes the schemas listed under
-- Settings → API → Exposed schemas, which is `public` by default — so
-- `app.config` was not reachable over the REST API as things stand. The
-- problem is that it is one checkbox away from being reachable, the checkbox
-- is in a UI somebody will eventually tick for an unrelated reason, and there
-- is no version of this system in which a driver should be able to call any of
-- these. A grant that is only safe because of a setting somewhere else is not
-- a safe grant.
--
-- The fix is the ordinary one: revoke from PUBLIC, then grant back by name.
-- Revoking from `authenticated` alone would do nothing, because the privilege
-- arrives through PUBLIC and is inherited.

-- ---------------------------------------------------------------- revoke
-- Everything, including the harmless ones, so that the grant list below is the
-- complete and auditable answer to "what can a signed-in user call?".

revoke execute on all functions in schema app from public, anon, authenticated;

-- New functions added to this schema later must not quietly reappear on the
-- PUBLIC grant. Anything genuinely needed by a policy gets an explicit grant
-- in the migration that adds it.
alter default privileges in schema app revoke execute on functions from public;

-- ------------------------------------------------------- the policy helpers
-- These six are named inside the RLS policies in 002 and 004. Policy
-- expressions run as the calling user, so without EXECUTE here every query
-- from a signed-in driver fails with "permission denied for function".
--
-- All six are SECURITY DEFINER and all six answer questions about the caller
-- and nobody else — they read `profiles` for `auth.uid()`. There is no
-- argument a caller can pass that makes them describe somebody else.

grant execute on function app.current_company()    to authenticated;
grant execute on function app.current_role()       to authenticated;
grant execute on function app.current_subhauler()  to authenticated;
grant execute on function app.is_office()          to authenticated;
grant execute on function app.is_admin()           to authenticated;
grant execute on function app.can_see_tag(tags)    to authenticated;

-- The storage policies in 004 parse an object key. Pure string functions over
-- their argument; they read nothing.
grant execute on function app.storage_company_matches(text) to authenticated;
grant execute on function app.storage_tag_id(text)          to authenticated;

-- ------------------------------------------------------------ pure helpers
-- No side effects, no reads, and their answers depend only on their arguments.
-- Granted because a query or an index expression may need them, and because
-- withholding them buys nothing.

grant execute on function app.alias_text(text[])              to authenticated;
grant execute on function app.match_floor()                   to authenticated;
grant execute on function app.phash_distance(bigint, bigint)  to authenticated;
grant execute on function app.phash_threshold()               to authenticated;

-- --------------------------------------------------------- trigger functions
-- Granted deliberately rather than left revoked.
--
-- Calling one of these directly raises "trigger functions can only be called
-- as triggers", so the grant confers nothing. What it avoids is the version of
-- this migration where an insert by a driver fails at trigger time on some
-- Postgres version that checks EXECUTE at fire time rather than at CREATE
-- TRIGGER time. The cost of being wrong about that is every capture failing;
-- the cost of granting is zero.

grant execute on function app.audit()                    to authenticated;
grant execute on function app.supersede_prior_image()    to authenticated;
grant execute on function app.open_rescan()              to authenticated;
grant execute on function app.close_rescan_on_new_image() to authenticated;
grant execute on function app.update_truck_tare()        to authenticated;
grant execute on function app.validate_after_extract()   to authenticated;
grant execute on function app.notify_rescan()            to authenticated;
grant execute on function app.notify_approved()          to authenticated;

-- ------------------------------------------------------------- still closed
-- Not granted to anybody, and each for a specific reason:
--
--   app.config(text)                    returns the service_role key
--   app.match_rate(...)                 any company's pricing
--   app.compute_pay_cents(...)          only ever called from approve_tag
--   app.sweep_unread_tags()             mutates the office's review queue
--   app.confidence_is_defensible(uuid)  reads an arbitrary tag
--   app.quarry_near_capture(uuid, int)  reads an arbitrary tag's location
--
-- Every one of them is called from inside a SECURITY DEFINER function that
-- runs as the owner — `approve_tag`, `validate_tag`, `apply_extraction`, the
-- cron job — so nothing that legitimately needs them loses access. A caller
-- reaching them directly was never part of the design.

-- ------------------------------------------------------------------- anon
-- `anon` is deliberately given nothing at all, not even schema usage.
--
-- Nobody uses this system without signing in. Sign-in is GoTrue, which is not
-- PostgREST and needs none of this; the moment it succeeds the caller is
-- `authenticated`. An anonymous read therefore fails at the schema boundary
-- before any policy is evaluated, which is the earliest and cheapest place for
-- it to fail.

revoke usage on schema app from anon;
