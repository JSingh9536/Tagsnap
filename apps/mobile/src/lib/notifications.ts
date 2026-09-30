import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

/**
 * Push notifications.
 *
 * Two things get pushed and nothing else: a rescan request, because the office
 * is now blocked on this driver, and an approval, because it is the one people
 * actually want. Push everything and people learn to swipe them away — and
 * then the rescan gets swiped away too.
 *
 * Registration is best-effort throughout. A driver who declines notifications
 * still sees rescans at the top of their list; they just find out later. That
 * is a worse experience, not a broken one, so nothing here is allowed to block
 * sign-in or throw into the app.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // shouldShowAlert is the older key and is still required by the type;
    // banner/list are the newer split of the same thing. Setting all three
    // keeps this correct across SDK versions.
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPush(profileId: string): Promise<void> {
  try {
    // A simulator has no push token to give. Bailing quietly keeps the
    // development experience from being a wall of warnings.
    if (!Device.isDevice) return;

    if (Platform.OS === 'android') {
      // A separate high-importance channel for rescans, so a driver can mute
      // approvals without muting the one where somebody is waiting on them.
      await Notifications.setNotificationChannelAsync('rescans', {
        name: 'Rescan requests',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#F5A623',
      });
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Updates',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;

    if (status !== 'granted') {
      const asked = await Notifications.requestPermissionsAsync();
      status = asked.status;
    }
    if (status !== 'granted') return;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      // app.json still has the placeholder EAS project id. Push cannot work
      // until that is filled in; see docs/SETUP.md.
      console.warn('No EAS projectId configured — push notifications are off.');
      return;
    }

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;

    // Upsert on the token, not on the profile: one person may carry two
    // phones, and one phone may be handed to a different driver. Keying on the
    // token lets both happen without either clobbering the other.
    await supabase.from('device_tokens').upsert(
      {
        profile_id: profileId,
        token,
        platform: Platform.OS,
        last_seen: new Date().toISOString(),
        active: true,
      },
      { onConflict: 'token' }
    );
  } catch (err) {
    console.warn('push registration failed', err);
  }
}

/**
 * Stop this device receiving another user's notifications after a handover.
 *
 * Called on sign-out. Shared phones are normal in a yard, and a driver picking
 * up yesterday's handset should not get pushes about someone else's tickets.
 */
export async function unregisterPush(): Promise<void> {
  try {
    if (!Device.isDevice) return;
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) return;

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await supabase.from('device_tokens').update({ active: false }).eq('token', token);
  } catch {
    // Signing out must succeed regardless.
  }
}

export type PushPayload =
  | { kind: 'rescan'; tagId: string }
  | { kind: 'approved'; tagId: string };

/**
 * Fires when a notification is tapped. Used to open the tag it refers to,
 * rather than dumping the driver on the list to hunt for it.
 */
export function onNotificationTapped(
  handler: (payload: PushPayload) => void
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as
      | PushPayload
      | undefined;
    if (data?.kind && data.tagId) handler(data);
  });
  return () => sub.remove();
}

/** Clears the badge. Called when the driver has actually looked at the list. */
export async function clearBadge(): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {
    // Not supported everywhere, and not important enough to care.
  }
}
