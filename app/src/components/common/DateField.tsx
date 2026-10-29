import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText, BottomSheet, Button, Icon, IconButton } from '@/components/ui';
import { makeStyles, useTheme } from '@/theme';
import {
  MONTH_NAMES,
  WEEKDAY_SHORT,
  dayAllowed,
  dayStart,
  fmtYmd,
  monthGrid,
  toYmd,
} from '@/utils/userWallets';

/**
 * The web's `<input type="date">`: shows the picked day, opens a month
 * calendar, and honours `min` / `max` so a From can never pass its To.
 */
export function DateField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (ymd: string) => void;
  min?: string;
  max?: string;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  // Opens on the picked day's month, else the bound's, else this month.
  const anchor = (): { y: number; m: number } => {
    const a = dayStart(value || max || min || toYmd(new Date())) ?? new Date();
    return { y: a.getFullYear(), m: a.getMonth() };
  };
  const [cursor, setCursor] = useState(anchor);

  const show = (): void => {
    setCursor(anchor());
    setOpen(true);
  };
  const step = (delta: number): void => setCursor((c) => {
    const d = new Date(c.y, c.m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const pick = (ymd: string): void => { onChange(ymd); setOpen(false); };
  const today = toYmd(new Date());
  const cells = monthGrid(cursor.y, cursor.m);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} date${value ? `, ${fmtYmd(value)}` : ''}`}
        onPress={show}
        style={[s.dateField, { borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
      >
        <AppText variant="body" tone={value ? 'primary' : 'muted'} numberOfLines={1} style={s.flex}>
          {value ? fmtYmd(value) : label}
        </AppText>
        <Icon name="chevronDown" size={12} color={t.colors.textMuted} strokeWidth={2.2} />
      </Pressable>
      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title={`${label} date`}
        footer={(
          <View style={s.dateFooter}>
            <Button title="Clear" variant="ghost" onPress={() => pick('')} style={s.flex} />
            <Button
              title="Today"
              variant="secondary"
              onPress={() => pick(today)}
              disabled={!dayAllowed(today, min, max)}
              style={s.flex}
            />
          </View>
        )}
      >
        <View style={s.calHead}>
          <IconButton name="chevronLeft" accessibilityLabel="Previous month" onPress={() => step(-1)} />
          <AppText variant="title" align="center" style={s.flex}>{`${MONTH_NAMES[cursor.m] ?? ''} ${cursor.y}`}</AppText>
          <IconButton name="chevronRight" accessibilityLabel="Next month" onPress={() => step(1)} />
        </View>
        <View style={s.week}>
          {WEEKDAY_SHORT.map((d) => (
            <AppText key={d} variant="caption" tone="muted" align="center" style={s.cell}>{d}</AppText>
          ))}
        </View>
        {weeks.map((week, wi) => (
          // eslint-disable-next-line react/no-array-index-key
          <View key={wi} style={s.week}>
            {week.map((ymd, di) => {
              if (!ymd) return <View key={`b${di}`} style={s.cell} />;
              const allowed = dayAllowed(ymd, min, max);
              const selected = ymd === value;
              return (
                <Pressable
                  key={ymd}
                  accessibilityRole="button"
                  accessibilityLabel={fmtYmd(ymd)}
                  accessibilityState={{ selected, disabled: !allowed }}
                  disabled={!allowed}
                  onPress={() => pick(ymd)}
                  style={[
                    s.cell,
                    s.day,
                    selected ? { backgroundColor: t.colors.primary } : null,
                    !selected && ymd === today ? { borderWidth: 1, borderColor: t.colors.primary } : null,
                    !allowed ? { opacity: 0.3 } : null,
                  ]}
                >
                  <AppText variant="body" weight={selected ? '700' : '400'} color={selected ? t.colors.onPrimary : undefined}>
                    {String(Number(ymd.slice(8)))}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        ))}
      </BottomSheet>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  flex: { flex: 1, minWidth: 0 },
  dateField: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: t.radius.lg,
    paddingHorizontal: 10,
    minHeight: 42,
  },
  dateFooter: { flexDirection: 'row', gap: t.space.sm },
  calHead: { flexDirection: 'row', alignItems: 'center', marginBottom: t.space.sm },
  week: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 40 },
  day: { borderRadius: 20, margin: 2 },
}));
