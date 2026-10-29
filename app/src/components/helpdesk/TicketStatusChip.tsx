import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';
import { ticketStatusLabel, ticketStatusTone } from '@/types/helpdesk';

/**
 * A ticket's status chip — Feedback.jsx / Helpdesk.jsx STATUS_STYLES: a
 * tinted background, border and text per status (unknown statuses look
 * OPEN), the status printed with its underscore as a space.
 */
export function TicketStatusChip({ status }: { status: string }): React.JSX.Element {
  const t = useTheme();
  const tone = ticketStatusTone(status);
  const hex = tone === 'info' ? t.colors.info
    : tone === 'primary' ? t.colors.primary
      : tone === 'warn' ? t.colors.warn
        : tone === 'bull' ? t.colors.bull
          : t.colors.bear;
  return (
    <View style={[styles.chip, { backgroundColor: t.alpha(hex, 0.15), borderColor: t.alpha(hex, 0.3) }]}>
      <AppText variant="micro" weight="700" color={hex}>{ticketStatusLabel(status).toUpperCase()}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, borderWidth: 1 },
});
