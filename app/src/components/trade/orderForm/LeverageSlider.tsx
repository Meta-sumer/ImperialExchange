import React, { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

/**
 * The leverage `<input type="range" min=1 max={sliderMax} step=1>`
 * (OrderForm.jsx:1901-1909), drawn with views: a track, the filled part in
 * the accent colour, a thumb. Touch or drag anywhere on it; whole steps.
 */
export const sliderValueAt = (x: number, width: number, min: number, max: number): number => {
  if (width <= 0 || max <= min) return min;
  const ratio = Math.max(0, Math.min(1, x / width));
  return Math.round(min + ratio * (max - min));
};

export function LeverageSlider({
  value,
  max,
  onChange,
  accent,
  track,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  accent: string;
  track: string;
}): React.JSX.Element {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const maxRef = useRef(max);
  maxRef.current = max;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        onChangeRef.current(sliderValueAt(e.nativeEvent.locationX, widthRef.current, 1, maxRef.current));
      },
      onPanResponderMove: (e) => {
        onChangeRef.current(sliderValueAt(e.nativeEvent.locationX, widthRef.current, 1, maxRef.current));
      },
    }),
  ).current;

  const onLayout = (e: LayoutChangeEvent): void => {
    widthRef.current = e.nativeEvent.layout.width;
    setWidth(e.nativeEvent.layout.width);
  };

  const ratio = max > 1 ? Math.max(0, Math.min(1, (value - 1) / (max - 1))) : 0;
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="Leverage"
      accessibilityValue={{ min: 1, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') onChange(Math.min(max, value + 1));
        if (e.nativeEvent.actionName === 'decrement') onChange(Math.max(1, value - 1));
      }}
      onLayout={onLayout}
      style={s.hit}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={[s.track, { backgroundColor: track }]}>
        <View style={[s.fill, { width: ratio * width, backgroundColor: accent }]} />
      </View>
      <View
        pointerEvents="none"
        style={[s.thumb, { left: Math.max(0, ratio * width - 8), borderColor: accent }]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  hit: { height: 24, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6 },
  thumb: { position: 'absolute', top: 4, width: 16, height: 16, borderRadius: 8, borderWidth: 2, backgroundColor: '#FFFFFF' },
});
