import { isServiceRole, json, preflight, serviceClient } from '../_shared/http.ts';
import { deliver, type PushMessage } from '../_shared/push.ts';

/**
 * Send a push notification to the person who filed a tag.
 *
 * Called by database triggers, not by a client — see 007_automation.sql.
 *
 * It therefore authenticates the *caller* rather than a user, by requiring the
 * service role key as the bearer token. That check is not decoration: the
 * gateway's `verify_jwt` accepts any valid key for the project, including the
 * publishable one that ships inside both apps, so without this anybody holding
 * a copy of the mobile app could post a rescan id here and make somebody
 * else's phone buzz. No data comes back either way, but a notification system
 * strangers can fire is a notification system people turn off.
 *
 * Two notifications, both worth the interruption:
 *
 *   - a rescan request, because the office is now blocked on the driver
 *   - an approval, because it is the one people actually want
 *
 * Nothing else pushes. A notification for every status change trains people to
 * swipe them away, and then the rescan gets swiped away too.
 *
 * Delivery goes straight to APNs and FCM — see _shared/push.ts. The Expo relay
 * the prototype used does not exist for a native build, and going direct is
 * both free and one fewer service between the office and a driver's phone.
 */

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const origin = req.headers.get('Origin');

  if (!isServiceRole(req)) {
    // Deliberately the same shape as every other refusal here, and
    // deliberately vague. "Not the service role" tells a prober exactly what
    // to go and look for.
    return json({ error: 'Not permitted.' }, 401, origin);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      rescan_id?: string;
      approved_tag_id?: string;
    };

    const svc = serviceClient();
    let target: { profileId: string; message: PushMessage } | null = null;

    if (body.rescan_id) {
      const { data } = await svc
        .from('rescan_requests')
        .select('reason, note, tags ( id, created_by, ticket_number )')
        .eq('id', body.rescan_id)
        .single();

      const tag = data?.tags as
        | { id: string; created_by: string; ticket_number: string | null }
        | undefined;

      if (tag) {
        target = {
          profileId: tag.created_by,
          message: {
            title: 'Retake a ticket photo',
            body:
              (tag.ticket_number ? `Ticket #${tag.ticket_number}: ` : '') +
              (data?.note ?? reasonText(data?.reason as string)),
            // High priority: this is the one where somebody is waiting.
            priority: 'high',
            data: {
              kind: 'rescan',
              tagId: tag.id,
              reason: (data?.reason as string) ?? 'other',
            },
            channelId: 'rescans',
          },
        };
      }
    } else if (body.approved_tag_id) {
      const { data: tag } = await svc
        .from('tags')
        .select('id, created_by, ticket_number, computed_pay_cents')
        .eq('id', body.approved_tag_id)
        .single();

      if (tag) {
        const amount =
          tag.computed_pay_cents !== null
            ? (tag.computed_pay_cents / 100).toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD',
              })
            : null;

        target = {
          profileId: tag.created_by,
          message: {
            title: 'Ticket approved',
            body: tag.ticket_number
              ? `Ticket #${tag.ticket_number}${amount ? ` — ${amount}` : ''}`
              : `A ticket you sent was approved${amount ? ` — ${amount}` : ''}`,
            priority: 'normal',
            data: { kind: 'approved', tagId: tag.id },
            channelId: 'default',
          },
        };
      }
    }

    if (!target) return json({ sent: 0, reason: 'nothing to notify' }, 200, origin);

    const { data: devices } = await svc
      .from('device_tokens')
      .select('token, platform')
      .eq('profile_id', target.profileId)
      .eq('active', true);

    if (!devices || devices.length === 0) {
      return json({ sent: 0, reason: 'no registered device' }, 200, origin);
    }

    const results = await deliver(devices, target.message);

    // A provider telling us a token belongs to an uninstalled app is worth
    // acting on. Leaving those active means every future send retries a dead
    // device forever, and eventually the provider throttles the whole app.
    const dead = results.filter((r) => r.retire).map((r) => r.token);
    if (dead.length > 0) {
      await svc.from('device_tokens').update({ active: false }).in('token', dead);
    }

    // Failures that are not retirements are worth seeing in the log — a
    // misconfigured APNs key looks exactly like "nobody has push" otherwise.
    for (const r of results) {
      if (!r.ok && !r.retire) console.error('push failed', r.detail);
    }

    return json(
      {
        sent: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok && !r.retire).length,
        retired: dead.length,
      },
      200,
      origin
    );
  } catch (err) {
    // A failed notification must never look like a failed rescan request. The
    // request is already saved; this is the doorbell, not the door.
    console.error('push failed', err);
    return json({ sent: 0, error: 'push failed' }, 200, origin);
  }
});

function reasonText(reason: string | undefined): string {
  const map: Record<string, string> = {
    unreadable: "The office can't read the photo. Retake it in better light.",
    cropped: 'Part of the ticket is cut off. Retake it with all four corners in frame.',
    wrong_document: 'That was not a scale ticket.',
    missing_fields: 'A field the office needs is not visible.',
    duplicate_check: 'This looks like a ticket already sent in.',
    other: 'The office needs a new photo.',
  };
  return map[reason ?? 'other'] ?? map.other!;
}
