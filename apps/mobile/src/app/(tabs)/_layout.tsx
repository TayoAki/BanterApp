import { Tabs } from 'expo-router/tabs';
import { Text } from 'react-native';
import { colors } from '../../lib/theme';

function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 20, color: focused ? colors.primary : colors.muted }} accessibilityElementsHidden>
      {glyph}
    </Text>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, minHeight: 56 },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        sceneStyle: { backgroundColor: colors.canvas },
      }}>
      <Tabs.Screen name="today" options={{ title: 'Today', tabBarIcon: ({ focused }) => <TabIcon glyph="⌂" focused={focused} /> }} />
      <Tabs.Screen name="learn" options={{ title: 'Learn', tabBarIcon: ({ focused }) => <TabIcon glyph="▤" focused={focused} /> }} />
      <Tabs.Screen name="progress" options={{ title: 'Progress', tabBarIcon: ({ focused }) => <TabIcon glyph="▮▮" focused={focused} /> }} />
    </Tabs>
  );
}
