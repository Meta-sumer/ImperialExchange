import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { HelpdeskChatPanel } from '@/components/helpdesk/HelpdeskChatPanel';
import { AppText, Screen } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';

/**
 * Support Chat — client/src/pages/HelpdeskChat.jsx at /helpdesk/chat: the
 * standalone page, with its own title and a link back to tickets and FAQ.
 * The panel itself is shared with the Helpdesk's "Live Chat" tab.
 */
export function HelpdeskChatScreen({ navigation }: AppScreenProps<'HelpdeskChat'>): React.JSX.Element {
  const t = useTheme();
  return (
    <Screen footer={false} testID="helpdesk-chat-screen">
      <View style={styles.head}>
        <AppText variant="h1" style={styles.flex}>Support Chat</AppText>
        <Pressable
          accessibilityRole="link"
          hitSlop={6}
          onPress={() => navigation.navigate('Helpdesk', undefined, { pop: true })}
        >
          <AppText variant="bodyStrong" color={t.colors.primaryText}>{'Tickets & FAQ →'}</AppText>
        </Pressable>
      </View>
      <HelpdeskChatPanel />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  flex: { flex: 1 },
});
