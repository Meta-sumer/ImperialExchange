import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg from 'react-native-svg';

/**
 * An SVG laid over its parent edge to edge — what a gradient background
 * needs.
 *
 * `<Svg style={StyleSheet.absoluteFill}>` is NOT that. Given no width /
 * height, react-native-svg sets both to "100%", which overrides the
 * stretch; on a device that came out as the parent's size MINUS its
 * padding, still pinned to the top-left corner. A padded button got a
 * gradient the size of its label, and its white text vanished into the
 * white page around it (the Landing CTAs on the Android emulator,
 * 2026-09-30). Tests lay nothing out, so none could see it.
 *
 * Here an absolute View does the stretching and the SVG fills that View,
 * which has no padding. Draw in user units with `viewBox` (and
 * `preserveAspectRatio="none"` to stretch), or in percentages without one.
 */
export function FillSvg({
  children,
  viewBox,
  preserveAspectRatio,
  style,
}: {
  children: React.ReactNode;
  viewBox?: string;
  preserveAspectRatio?: string;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%" viewBox={viewBox} preserveAspectRatio={preserveAspectRatio}>
        {children}
      </Svg>
    </View>
  );
}
