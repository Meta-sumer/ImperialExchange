import * as Haptics from 'expo-haptics';
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  RefreshControl,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type FlatList,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useTheme } from '@/theme';

import {
  DROP_MS,
  FLIP_MS,
  LONG_PRESS_MS,
  clamp,
  edgeScrollDelta,
  nearestSlot,
  reorderedIds,
  sameOrder,
  visualIndex,
} from './dragMath';

/**
 * A vertical list you reorder by long-pressing a row and dragging it —
 * client/src/components/DraggableList.jsx on a phone.
 *
 * What it keeps from the web, item for item:
 *   • The lifted row floats in a copy under the finger (95% opacity, 1.02
 *     scale, soft shadow) and its slot becomes a dashed placeholder of the
 *     same size.
 *   • The order changes LIVE while dragging: neighbours slide (~240 ms) to
 *     open the gap before release; the placeholder jumps.
 *   • On release the copy settles into the slot (~220 ms) and only then is
 *     the order saved — once, and only when it changed.
 *   • Dragging near the top / bottom edge scrolls the list (64 dp band,
 *     up to 16 dp a frame).
 *   • A non-pointer way to reorder: each row offers "Move up" / "Move down"
 *     (`moveUp` / `moveDown`, and screen-reader actions on `a11yProps`) —
 *     the web's keyboard lift-and-arrow.
 *
 * Phone-specific: a LONG PRESS lifts (300 ms, with a light haptic), because
 * a plain drag on a touch screen means "scroll". The row keeps its own
 * buttons — only what `dragArea` wraps starts a drag, as the web keeps its
 * Trade link and ⋯ menu out of the grab.
 *
 * Rows must share one height (the watchlist rows do); it is measured, not
 * assumed. A virtualised FlatList underneath: lists run to hundreds.
 */

export interface DragA11yProps {
  accessibilityActions: AccessibilityActionInfo[];
  onAccessibilityAction: (e: AccessibilityActionEvent) => void;
}

export interface DragItemInfo {
  index: number;
  /** Wrap the part of the row a long press lifts. */
  dragArea: (node: ReactNode) => ReactElement;
  /** The floating copy under the finger. */
  isOverlay: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveUp: () => void;
  moveDown: () => void;
  /** "Move up" / "Move down" for screen readers — spread on the grip. */
  a11yProps: DragA11yProps;
}

export interface DraggableListProps<T> {
  items: readonly T[];
  getId: (item: T) => string;
  renderItem: (item: T, info: DragItemInfo) => ReactElement;
  /** Called once per drop (or move), only when the order changed. */
  onReorder: (orderedIds: string[]) => void;
  disabled?: boolean;
  /** Space between rows — the web's `gap` (8). */
  gap?: number;
  /** Content padding: rows sit `paddingTop` below the header. */
  paddingTop?: number;
  paddingBottom?: number;
  paddingHorizontal?: number;
  ListHeaderComponent?: ReactElement | null;
  ListEmptyComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  extraData?: unknown;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface Shared {
  from: SharedValue<number>;
  hover: SharedValue<number>;
  session: SharedValue<boolean>;
  dragging: SharedValue<boolean>;
  animate: SharedValue<boolean>;
  base: SharedValue<Record<string, number>>;
  ids: SharedValue<string[]>;
  activeId: SharedValue<string>;
  stride: SharedValue<number>;
  rowH: SharedValue<number>;
  header: SharedValue<number>;
  padTop: SharedValue<number>;
  scroll: SharedValue<number>;
  startTop: SharedValue<number>;
  overlayTop: SharedValue<number>;
}

interface CellProps<T> {
  id: string;
  index: number;
  item: T;
  count: number;
  isActive: boolean;
  /** The measured row height, for the placeholder. */
  rowHeight: number;
  disabled: boolean;
  gap: number;
  sh: Shared;
  renderItem: (item: T, info: DragItemInfo) => ReactElement;
  onLift: (id: string) => void;
  onSettle: (from: number, hover: number) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onRowHeight: (h: number) => void;
  updateHover: () => void;
  testID?: string;
}

function CellInner<T>({
  id,
  index,
  item,
  count,
  isActive,
  rowHeight,
  disabled,
  gap,
  sh,
  renderItem,
  onLift,
  onSettle,
  onMove,
  onRowHeight,
  updateHover,
  testID,
}: CellProps<T>): React.JSX.Element {
  const t = useTheme();

  const style = useAnimatedStyle(() => {
    if (!sh.session.value) return { transform: [{ translateY: 0 }] };
    const b = sh.base.value[id];
    if (b === undefined) return { transform: [{ translateY: 0 }] };
    const target = (visualIndex(b, sh.from.value, sh.hover.value) - index) * sh.stride.value;
    // The lifted row's placeholder jumps; its neighbours glide.
    if (!sh.animate.value || id === sh.activeId.value) return { transform: [{ translateY: target }] };
    return { transform: [{ translateY: withTiming(target, { duration: FLIP_MS }) }] };
  }, [id, index]);

  const pan = useMemo(() => Gesture.Pan()
    .activateAfterLongPress(LONG_PRESS_MS)
    .enabled(!disabled)
    .withTestId(`drag-${id}`)
    .onStart(() => {
      'worklet';
      const ids = sh.ids.value;
      const base: Record<string, number> = {};
      for (let i = 0; i < ids.length; i++) base[ids[i] as string] = i;
      sh.base.value = base;
      sh.activeId.value = id;
      sh.from.value = index;
      sh.hover.value = index;
      sh.animate.value = true;
      sh.session.value = true;
      sh.dragging.value = true;
      const top = sh.padTop.value + sh.header.value + index * sh.stride.value - sh.scroll.value;
      sh.startTop.value = top;
      sh.overlayTop.value = top;
      scheduleOnRN(onLift, id);
    })
    .onUpdate((e) => {
      'worklet';
      if (!sh.dragging.value) return;
      sh.overlayTop.value = sh.startTop.value + e.translationY;
      updateHover();
    })
    .onFinalize((_e, success) => {
      'worklet';
      if (!sh.dragging.value || sh.activeId.value !== id) return;
      sh.dragging.value = false;
      // Cancelled (the system took the touch): home, as the web's Escape.
      if (!success) sh.hover.value = sh.from.value;
      const from = sh.from.value;
      const hover = sh.hover.value;
      const target = sh.padTop.value + sh.header.value + hover * sh.stride.value - sh.scroll.value;
      sh.overlayTop.value = withTiming(target, { duration: DROP_MS }, () => {
        scheduleOnRN(onSettle, from, hover);
      });
    }), [disabled, id, index, onLift, onSettle, sh, updateHover]);

  const dragArea = useCallback(
    (node: ReactNode): ReactElement => <GestureDetector gesture={pan}>{node as ReactElement}</GestureDetector>,
    [pan],
  );

  const moveUp = useCallback(() => onMove(id, -1), [id, onMove]);
  const moveDown = useCallback(() => onMove(id, 1), [id, onMove]);
  const canMoveUp = !disabled && index > 0;
  const canMoveDown = !disabled && index < count - 1;

  const a11yProps = useMemo<DragA11yProps>(() => ({
    accessibilityActions: [
      ...(canMoveUp ? [{ name: 'moveUp', label: 'Move up' }] : []),
      ...(canMoveDown ? [{ name: 'moveDown', label: 'Move down' }] : []),
    ],
    onAccessibilityAction: (e: AccessibilityActionEvent) => {
      if (e.nativeEvent.actionName === 'moveUp') moveUp();
      else if (e.nativeEvent.actionName === 'moveDown') moveDown();
    },
  }), [canMoveDown, canMoveUp, moveDown, moveUp]);

  const onLayout = useCallback((e: LayoutChangeEvent) => onRowHeight(e.nativeEvent.layout.height), [onRowHeight]);

  return (
    <Animated.View style={[{ marginBottom: gap }, style]} onLayout={onLayout} testID={testID}>
      {isActive ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.placeholder,
            {
              height: rowHeight > 0 ? rowHeight : undefined,
              borderColor: t.alpha(t.colors.primary, 0.6),
              backgroundColor: t.alpha(t.colors.primary, 0.1),
              borderRadius: t.radius.xl,
            },
          ]}
        />
      ) : (
        renderItem(item, { index, dragArea, isOverlay: false, canMoveUp, canMoveDown, moveUp, moveDown, a11yProps })
      )}
    </Animated.View>
  );
}

const Cell = memo(CellInner) as typeof CellInner;

const passThrough = (node: ReactNode): ReactElement => <>{node}</>;
const noop = (): void => undefined;
const NO_A11Y: DragA11yProps = { accessibilityActions: [], onAccessibilityAction: noop };

export function DraggableList<T>({
  items,
  getId,
  renderItem,
  onReorder,
  disabled = false,
  gap = 8,
  paddingTop = 0,
  paddingBottom = 0,
  paddingHorizontal = 0,
  ListHeaderComponent,
  ListEmptyComponent,
  ListFooterComponent,
  onRefresh,
  refreshing = false,
  extraData,
  style,
  testID,
}: DraggableListProps<T>): React.JSX.Element {
  const t = useTheme();
  const listRef = useAnimatedRef<FlatList<T>>();

  // The order just dropped, shown until the items prop catches up — the
  // web's internal `order` state, which follows the items while idle.
  const itemIds = useMemo(() => items.map(getId), [items, getId]);
  const [pending, setPending] = useState<string[] | null>(null);
  useEffect(() => { setPending(null); }, [items]);
  const orderIds = useMemo(() => {
    if (!pending || pending.length !== itemIds.length) return itemIds;
    const have = new Set(itemIds);
    return pending.every((id) => have.has(id)) ? pending : itemIds;
  }, [pending, itemIds]);
  const byId = useMemo(() => new Map(items.map((it) => [getId(it), it])), [items, getId]);
  const data = useMemo(() => orderIds.map((id) => byId.get(id)).filter((x): x is T => x !== undefined), [orderIds, byId]);

  const orderRef = useRef(orderIds);
  orderRef.current = orderIds;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [settleSeq, setSettleSeq] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);

  const sh: Shared = {
    from: useSharedValue(-1),
    hover: useSharedValue(-1),
    session: useSharedValue(false),
    dragging: useSharedValue(false),
    animate: useSharedValue(true),
    base: useSharedValue<Record<string, number>>({}),
    ids: useSharedValue<string[]>(orderIds),
    activeId: useSharedValue(''),
    stride: useSharedValue(72),
    rowH: useSharedValue(0),
    header: useSharedValue(0),
    padTop: useSharedValue(paddingTop),
    scroll: useSharedValue(0),
    startTop: useSharedValue(0),
    overlayTop: useSharedValue(0),
  };
  // The object is rebuilt each render; its members are stable refs.
  const shRef = useRef(sh);
  const stableSh = shRef.current;

  const viewport = useSharedValue(0);
  const content = useSharedValue(0);

  useEffect(() => { stableSh.ids.value = orderIds; }, [orderIds, stableSh]);
  useEffect(() => { stableSh.padTop.value = paddingTop; }, [paddingTop, stableSh]);

  const updateHover = useCallback(() => {
    'worklet';
    const offset = stableSh.overlayTop.value + stableSh.scroll.value - stableSh.padTop.value - stableSh.header.value;
    const h = nearestSlot(offset, stableSh.stride.value, stableSh.ids.value.length);
    if (h !== stableSh.hover.value) stableSh.hover.value = h;
  }, [stableSh]);

  // Auto-scroll while a row is held near an edge.
  const autoScroll = useFrameCallback(() => {
    'worklet';
    if (!stableSh.dragging.value) return;
    const top = stableSh.overlayTop.value;
    const delta = edgeScrollDelta(top, top + stableSh.rowH.value, viewport.value);
    if (delta === 0) return;
    const maxY = Math.max(0, content.value - viewport.value);
    const y = clamp(stableSh.scroll.value + delta, 0, maxY);
    if (y === stableSh.scroll.value) return;
    stableSh.scroll.value = y;
    scrollTo(listRef, 0, y, false);
    updateHover();
  }, false);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => { stableSh.scroll.value = e.contentOffset.y; },
  });

  const onLift = useCallback((id: string) => {
    setActiveId(id);
    autoScrollRef.current.setActive(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    } catch { /* no haptics on this device */ }
  }, []);

  const onSettle = useCallback((from: number, hover: number) => {
    autoScrollRef.current.setActive(false);
    // Neighbours are at rest by now; later index changes must not animate.
    stableSh.animate.value = false;
    const ids = orderRef.current;
    const next = from >= 0 && hover >= 0 && from !== hover ? reorderedIds(ids, from, hover) : ids;
    setActiveId(null);
    if (!sameOrder(next, ids)) {
      setPending(next);
      onReorderRef.current(next);
    }
    setSettleSeq((n) => n + 1);
  }, [stableSh]);

  // After the dropped order has rendered, end the session. Every row then
  // sits where its layout puts it; the short delay lets the new layout
  // reach the screen before the shifts are dropped.
  useEffect(() => {
    if (settleSeq === 0) return undefined;
    const timer = setTimeout(() => {
      if (stableSh.dragging.value) return;
      stableSh.session.value = false;
      stableSh.from.value = -1;
      stableSh.hover.value = -1;
      stableSh.activeId.value = '';
    }, 80);
    return () => clearTimeout(timer);
  }, [settleSeq, stableSh]);

  const onMove = useCallback((id: string, dir: -1 | 1) => {
    const ids = orderRef.current;
    const from = ids.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = reorderedIds(ids, from, to);
    setPending(next);
    onReorderRef.current(next);
  }, []);

  const onRowHeight = useCallback((h: number) => {
    if (h <= 0) return;
    setRowHeight((prev) => (Math.abs(h - prev) <= 0.5 ? prev : h));
  }, []);

  useEffect(() => {
    if (rowHeight <= 0) return;
    stableSh.rowH.value = rowHeight;
    stableSh.stride.value = rowHeight + gap;
  }, [gap, rowHeight, stableSh]);

  const overlayStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: stableSh.overlayTop.value }, { scale: 1.02 }],
  }));

  const header = useMemo(() => (ListHeaderComponent ? (
    <View onLayout={(e) => { stableSh.header.value = e.nativeEvent.layout.height; }}>{ListHeaderComponent}</View>
  ) : null), [ListHeaderComponent, stableSh]);

  const activeItem = activeId ? byId.get(activeId) : undefined;

  return (
    <View style={[styles.flex, style]}>
      <Animated.FlatList
        ref={listRef as never}
        testID={testID}
        data={data}
        extraData={[extraData, activeId, disabled]}
        keyExtractor={(it: T) => getId(it)}
        renderItem={({ item, index }: { item: T; index: number }) => {
          const id = getId(item);
          return (
            <Cell
              id={id}
              index={index}
              item={item}
              count={data.length}
              isActive={id === activeId}
              rowHeight={rowHeight}
              disabled={disabled}
              gap={gap}
              sh={stableSh}
              renderItem={renderItem}
              onLift={onLift}
              onSettle={onSettle}
              onMove={onMove}
              onRowHeight={onRowHeight}
              updateHover={updateHover}
            />
          );
        }}
        ListHeaderComponent={header}
        ListEmptyComponent={ListEmptyComponent}
        ListFooterComponent={ListFooterComponent}
        contentContainerStyle={{ paddingTop, paddingBottom, paddingHorizontal, flexGrow: 1 }}
        scrollEnabled={activeId === null}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(e: LayoutChangeEvent) => { viewport.value = e.nativeEvent.layout.height; }}
        onContentSizeChange={(_w: number, h: number) => { content.value = h; }}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
        refreshControl={onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={t.colors.primary}
            colors={[t.colors.primary]}
            progressBackgroundColor={t.colors.surface}
          />
        ) : undefined}
      />
      {activeItem !== undefined ? (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.overlay,
            t.shadow.elevated,
            { left: paddingHorizontal, right: paddingHorizontal, borderRadius: t.radius.xl },
            overlayStyle,
          ]}
        >
          {renderItem(activeItem, {
            index: orderIds.indexOf(activeId ?? ''),
            dragArea: passThrough,
            isOverlay: true,
            canMoveUp: false,
            canMoveDown: false,
            moveUp: noop,
            moveDown: noop,
            a11yProps: NO_A11Y,
          })}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  placeholder: { borderWidth: 2, borderStyle: 'dashed', minHeight: 56 },
  overlay: { position: 'absolute', top: 0, opacity: 0.95, zIndex: 10 },
});
