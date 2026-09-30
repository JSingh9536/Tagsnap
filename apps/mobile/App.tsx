import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  NavigationContainer,
  DefaultTheme,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { AuthProvider, useAuth } from './src/state/auth';
import { TagsProvider, useTags } from './src/state/tags';
import { PortalScreen } from './src/screens/PortalScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { LockScreen } from './src/screens/LockScreen';
import { TagsScreen } from './src/screens/TagsScreen';
import { TagDetailScreen } from './src/screens/TagDetailScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { PayScreen } from './src/screens/PayScreen';
import { AccountScreen } from './src/screens/AccountScreen';
import type { CaptureParams } from './src/screens/CaptureScreen';
import { onNotificationTapped } from './src/lib/notifications';
import { Spinner } from './src/components/ui';
import { accentFor, colors, space, type } from './src/theme';

/** The stack's routes and what each one is handed. */
export type RootStackParamList = {
  Main: undefined;
  TagDetail: { tagId: string };
  Capture: CaptureParams | undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

/**
 * Held outside the tree so a notification tap can navigate.
 *
 * A push that dumps the driver on the list to hunt for the ticket it was about
 * is a push that gets ignored. Tapping "Retake a ticket photo" has to open
 * that ticket.
 */
const navigationRef = createNavigationContainerRef<RootStackParamList>();

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.driver,
    notification: colors.attention,
  },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <TagsProvider>
          <Root />
        </TagsProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

/**
 * Three gates, in order: is the session still loading, is the app locked, and
 * has this person picked a portal and signed in. Anything past all three is
 * the field app proper.
 */
function Root() {
  const { loading, profile, portal, locked } = useAuth();

  React.useEffect(() => {
    return onNotificationTapped(({ tagId }) => {
      if (navigationRef.isReady()) {
        navigationRef.navigate('TagDetail', { tagId });
      }
    });
  }, []);

  if (loading) {
    return (
      <View style={s.boot}>
        <Spinner label="Signing you in…" />
      </View>
    );
  }

  if (profile && locked) return <LockScreen />;

  if (!profile) {
    return (
      <NavigationContainer theme={navTheme}>
        {portal === null ? <PortalScreen /> : <SignInScreen />}
      </NavigationContainer>
    );
  }

  return (
    <NavigationContainer theme={navTheme} ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitleStyle: { color: colors.text },
          headerTintColor: colors.text,
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen
          name="Main"
          component={MainTabs}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="TagDetail"
          component={TagDetailScreen as never}
          options={{ title: 'Ticket' }}
        />
        <Stack.Screen
          name="Capture"
          component={CaptureScreen as never}
          options={{ headerShown: false, presentation: 'fullScreenModal' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function MainTabs() {
  const { portal } = useAuth();
  const { rescans, outbox } = useTags();
  const accent = accentFor(portal);

  const unsent = outbox.filter((o) => o.state !== 'sent').length;

  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { color: colors.text },
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 64,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: { fontSize: 13, fontWeight: '600' },
      }}
    >
      <Tab.Screen
        name="Tickets"
        component={TagsScreen as never}
        options={{
          // The badge counts what needs the driver, not what exists. A rescan
          // is someone waiting on them; an unsent tag is the phone's problem.
          tabBarBadge: rescans.length > 0 ? rescans.length : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.attention, color: colors.onAccent },
          tabBarIcon: ({ color }) => <TabGlyph label="≡" color={color} />,
        }}
      />
      <Tab.Screen
        name="Scan"
        component={ScanTabPlaceholder}
        options={{
          tabBarButton: (props) => (
            <ScanButton onPress={props.onPress as () => void} accent={accent} />
          ),
        }}
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            // The camera is a modal, not a tab. Making it a tab would leave a
            // live camera running behind the other screens.
            e.preventDefault();
            navigation.navigate('Capture');
          },
        })}
      />
      <Tab.Screen
        name="Pay"
        component={PayScreen as never}
        options={{ tabBarIcon: ({ color }) => <TabGlyph label="$" color={color} /> }}
      />
      <Tab.Screen
        name="Account"
        component={AccountScreen as never}
        options={{
          tabBarBadge: unsent > 0 ? unsent : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.pending, color: '#fff' },
          tabBarIcon: ({ color }) => <TabGlyph label="●" color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}

/** Never rendered — the tab press is intercepted and routed to the modal. */
function ScanTabPlaceholder() {
  return <View style={s.boot} />;
}

function ScanButton({
  onPress,
  accent,
}: {
  onPress?: () => void;
  accent: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Photograph a scale ticket"
      style={s.scanWrap}
    >
      <View style={[s.scanButton, { backgroundColor: accent }]}>
        <Text style={s.scanGlyph}>+</Text>
      </View>
      <Text style={[s.scanLabel, { color: accent }]}>Scan</Text>
    </Pressable>
  );
}

function TabGlyph({ label, color }: { label: string; color: string }) {
  return <Text style={[s.glyph, { color }]}>{label}</Text>;
}

const s = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 20, fontWeight: '700' },

  scanWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  scanButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -space.md,
  },
  scanGlyph: { ...type.title, color: colors.onAccent, lineHeight: 30 },
  scanLabel: { fontSize: 13, fontWeight: '600' },
});
