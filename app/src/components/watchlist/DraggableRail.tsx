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
  StyleSheet,
  type AccessibilityActionEvent,
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

import type { DragA11yProps } from './DraggableList';
import {
  DROP_MS,
  FLIP_MS,
  LONG_PRESS_MS,
  clamp,
  edgeScrollDelta,
  railNearest,
  railShift,
  railSlotX,
  reorderedIds,
  sameOrder,
  visualIndex,
} from './dragMath';

/**
 * A horizontal pill rail you reorder by long-pressing a pill and dragging
 * it — the web's list reorder (the watchlist tabs are `draggable`, and the
 * desktop sidebar DnD's them), with DraggableList.jsx's horizontal axis
 * behaviour: the lifted pill follows the finger, its neighbours slide out of
 * the way, the rail scrolls at its edges, and the new order is saved once on
 * release. Pills may differ in width; each is measured.
 *
 * Accessible fallback: every pill carries "Move left" / "Move right"
 * screen-reader actions (`a11yProps`) and `moveLeft` / `moveRight`.
 *
 * The rail holds the trader's own lists, which they create one by one — a
 * handful, not a catalogue — so every pill is laid out (the drag has to
 * measure them all) rather than virtualised.
 */

export interface RailItemInfo {
  index: number;
  dragArea: (node: ReactNode) => ReactElement;
  /** Being dragged right now. */
  isLifted: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  moveLeft: () => void;
  moveRight: () => void;
  a11yProps: DragA11yProps;
}

export interface DraggableRailProps<T> {
  items: readonly T[];
  getId: (item: T) => string;
  renderItem: (item: T, info: RailItemInfo) => ReactElement;
  onReorder: (orderedIds: string[]) => void;
  disabled?: boolean;
  gap?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
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
  xs: SharedValue<number[]>;
  ws: SharedValue<number[]>;
  ids: SharedValue<string[]>;
  layout: SharedValue<Record<string, { x: number; w: number }>>;
  activeId: SharedValue<string>;
  touchX: SharedValue<number>;
  lift: SharedValue<number>;
  scroll: SharedValue<number>;
  startScroll: SharedValue<number>;
  gap: SharedValue<number>;
}

interface CellProps<T> {
  id: string;
  index: number;
  item: T;
  count: number;
  disabled: boolean;
  lifted: boolean;
  sh: Shared;
  renderItem: (item: T, info: RailItemInfo) => ReactElement;
  onLift: (id: string) => void;
  onSettle: (from: number, hover: number) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onMeasure: (id: string, x: number, w: number) => void;
  refresh: () => void;
}

function RailCellInner<T>({
  id,
  index,
  item,
  count,
  disabled,
  lifted,
  sh,
  renderItem,
  onLift,
  onSettle,
  onMove,
  onMeasure,
  refresh,
}: CellProps<T>): React.JSX.Element {
  const style = useAnimatedStyle(() => {
    if (!sh.session.value) return { transform: [{ translateX: 0 }, { scale: 1 }], zIndex: 0 };
    const b = sh.base.value[id];
    if (b === undefined) return { transform: [{ translateX: 0 }, { scale: 1 }], zIndex: 0 };
    const from = sh.from.value;
    const hover = sh.hover.value;
    // Once the dropped order has been laid out, the layout already puts
    // every pill where the drag showed it.
    if (index !== b && index === visualIndex(b, from, hover)) {
      return { transform: [{ translateX: 0 }, { scale: 1 }], zIndex: 0 };
    }
    if (id === sh.activeId.value) {
      return { transform: [{ translateX: sh.lift.value }, { scale: sh.dragging.value ? 1.05 : 1 }], zIndex: 10 };
    }
    const target = railShift(b, from, hover, sh.ws.value, sh.gap.value);
    if (!sh.animate.value) return { transform: [{ translateX: target }, { scale: 1 }], zIndex: 0 };
    return { transform: [{ translateX: withTiming(target, { duration: FLIP_MS }) }, { scale: 1 }], zIndex: 0 };
  }, [id, index]);

  const pan = useMemo(() => Gesture.Pan()
    .activateAfterLongPress(LONG_PRESS_MS)
    .enabled(!disabled)
    .withTestId(`rail-drag-${id}`)
    .onStart(() => {
      'worklet';
      const ids = sh.ids.value;
      const base: Record<string, number> = {};
      const xs: number[] = [];
      const ws: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const key = ids[i] as string;
        base[key] = i;
        const l = sh.layout.value[key];
        xs.push(l ? l.x : 0);
        ws.push(l ? l.w : 0);
      }
      sh.base.value = base;
      sh.xs.value = xs;
      sh.ws.value = ws;
      sh.activeId.value = id;
      sh.from.value = index;
      sh.hover.value = index;
      sh.touchX.value = 0;
      sh.lift.value = 0;
      sh.startScroll.value = sh.scroll.value;
      sh.animate.value = true;
      sh.session.value = true;
      sh.dragging.value = true;
      scheduleOnRN(onLift, id);
    })
    .onUpdate((e) => {
      'worklet';
      if (!sh.dragging.value) return;
      sh.touchX.value = e.translationX;
      refresh();
    })
    .onFinalize((_e, success) => {
      'worklet';
      if (!sh.dragging.value || sh.activeId.value !== id) return;
      sh.dragging.value = false;
      if (!success) sh.hover.value = sh.from.value;
      const from = sh.from.value;
      const hover = sh.hover.value;
      const xs = sh.xs.value;
      const target = railSlotX(hover, from, xs, sh.ws.value) - (xs[from] ?? 0);
      sh.lift.value = withTiming(target, { duration: DROP_MS }, () => {
        scheduleOnRN(onSettle, from, hover);
      });
    }), [disabled, id, index, onLift, onSettle, refresh, sh]);

  const dragArea = useCallback(
    (node: ReactNode): ReactElement => <GestureDetector gesture={pan}>{node as ReactElement}</GestureDetector>,
    [pan],
  );
  const moveLeft = useCallback(() => onMove(id, -1), [id, onMove]);
  const moveRight = useCallback(() => onMove(id, 1), [id, onMove]);
  const canMoveLeft = !disabled && index > 0;
  const canMoveRight = !disabled && index < count - 1;
  const a11yProps = useMemo<DragA11yProps>(() => ({
    accessibilityActions: [
      ...(canMoveLeft ? [{ name: 'moveLeft', label: 'Move left' }] : []),
      ...(canMoveRight ? [{ name: 'moveRight', label: 'Move right' }] : []),
    ],
    onAccessibilityAction: (e: AccessibilityActionEvent) => {
      if (e.nativeEvent.actionName === 'moveLeft') moveLeft();
      else if (e.nativeEvent.actionName === 'moveRight') moveRight();
    },
  }), [canMoveLeft, canMoveRight, moveLeft, moveRight]);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => onMeasure(id, e.nativeEvent.layout.x, e.nativeEvent.layout.width),
    [id, onMeasure],
  );

  return (
    <Animated.View style={style} onLayout={onLayout}>
      {renderItem(item, { index, dragArea, isLifted: lifted, canMoveLeft, canMoveRight, moveLeft, moveRight, a11yProps })}
    </Animated.View>
  );
}

const RailCell = memo(RailCellInner) as typeof RailCellInner;

export function DraggableRail<T>({
  items,
  getId,
  renderItem,
  onReorder,
  disabled = false,
  gap = 8,
  paddingHorizontal = 0,
  paddingVertical = 0,
  style,
  testID,
}: DraggableRailProps<T>): React.JSX.Element {
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  const itemIds = useMemo(() => items.map(getId), [items, getId]);
  const [pending, setPending] = useState<string[] | null>(null);
  useEffect(() => { setPending(null); }, [items]);
  const orderIds = useMemo(() => {
    if (!pending || pending.length !== itemIds.length) return itemIds;
    const have = new Set(itemIds);
    return pending.every((id) => have.has(id)) ? pending : itemIds;
  }, [pending, itemIds]);
  const byId = useMemo(() => new Map(items.map((it) => [getId(it), it])), [items, getId]);

  const orderRef = useRef(orderIds);
  orderRef.current = orderIds;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const [liftedId, setLiftedId] = useState<string | null>(null);
  const [settleSeq, setSettleSeq] = useState(0);

  const sh: Shared = {
    from: useSharedValue(-1),
    hover: useSharedValue(-1),
    session: useSharedValue(false),
    dragging: useSharedValue(false),
    animate: useSharedValue(true),
    base: useSharedValue<Record<string, number>>({}),
    xs: useSharedValue<number[]>([]),
    ws: useSharedValue<number[]>([]),
    ids: useSharedValue<string[]>(orderIds),
    layout: useSharedValue<Record<string, { x: number; w: number }>>({}),
    activeId: useSharedValue(''),
    touchX: useSharedValue(0),
    lift: useSharedValue(0),
    scroll: useSharedValue(0),
    startScroll: useSharedValue(0),
    gap: useSharedValue(gap),
  };
  const shRef = useRef(sh);
  const stable = shRef.current;
  const viewport = useSharedValue(0);
  const content = useSharedValue(0);

  useEffect(() => { stable.ids.value = orderIds; }, [orderIds, stable]);
  useEffect(() => { stable.gap.value = gap; }, [gap, stable]);

  const layouts = useRef<Record<string, { x: number; w: number }>>({});
  const onMeasure = useCallback((id: string, x: number, w: number) => {
    const prev = layouts.current[id];
    if (prev && prev.x === x && prev.w === w) return;
    layouts.current = { ...layouts.current, [id]: { x, w } };
    stable.layout.value = layouts.current;
  }, [stable]);

  const refresh = useCallback(() => {
    'worklet';
    const from = stable.from.value;
    const xs = stable.xs.value;
    stable.lift.value = stable.touchX.value + stable.scroll.value - stable.startScroll.value;
    const h = railNearest((xs[from] ?? 0) + stable.lift.value, from, xs, stable.ws.value);
    if (h !== stable.hover.value) stable.hover.value = h;
  }, [stable]);

  const autoScroll = useFrameCallback(() => {
    'worklet';
    if (!stable.dragging.value) return;
    const from = stable.from.value;
    const left = (stable.xs.value[from] ?? 0) + stable.lift.value - stable.scroll.value;
    const delta = edgeScrollDelta(left, left + (stable.ws.value[from] ?? 0), viewport.value);
    if (delta === 0) return;
    const maxX = Math.max(0, content.value - viewport.value);
    const x = clamp(stable.scroll.value + delta, 0, maxX);
    if (x === stable.scroll.value) return;
    stable.scroll.value = x;
    scrollTo(scrollRef, x, 0, false);
    refresh();
  }, false);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => { stable.scroll.value = e.contentOffset.x; },
  });

  const onLift = useCallback((id: string) => {
    setLiftedId(id);
    autoScrollRef.current.setActive(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    } catch { /* no haptics on this device */ }
  }, []);

  const onSettle = useCallback((from: number, hover: number) => {
    autoScrollRef.current.setActive(false);
    stable.animate.value = false;
    const ids = orderRef.current;
    const next = from >= 0 && hover >= 0 && from !== hover ? reorderedIds(ids, from, hover) : ids;
    setLiftedId(null);
    if (!sameOrder(next, ids)) {
      setPending(next);
      onReorderRef.current(next);
    }
    setSettleSeq((n) => n + 1);
  }, [stable]);

  useEffect(() => {
    if (settleSeq === 0) return undefined;
    const timer = setTimeout(() => {
      if (stable.dragging.value) return;
      stable.session.value = false;
      stable.from.value = -1;
      stable.hover.value = -1;
      stable.activeId.value = '';
      stable.lift.value = 0;
    }, 80);
    return () => clearTimeout(timer);
  }, [settleSeq, stable]);

  const onMove = useCallback((id: string, dir: -1 | 1) => {
    const ids = orderRef.current;
    const from = ids.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = reorderedIds(ids, from, to);
    setPending(next);
    onReorderRef.current(next);
  }, []);

  return (
    <Animated.ScrollView
      ref={scrollRef}
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      scrollEnabled={liftedId === null}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onLayout={(e: LayoutChangeEvent) => { viewport.value = e.nativeEvent.layout.width; }}
      onContentSizeChange={(w: number) => { content.value = w; }}
      style={style}
      contentContainerStyle={[styles.row, { gap, paddingHorizontal, paddingVertical }]}
      keyboardShouldPersistTaps="handled"
    >
      {orderIds.map((id, index) => {
        const item = byId.get(id);
        if (item === undefined) return null;
        return (
          <RailCell
            key={id}
            id={id}
            index={index}
            item={item}
            count={orderIds.length}
            disabled={disabled}
            lifted={id === liftedId}
            sh={stable}
            renderItem={renderItem}
            onLift={onLift}
            onSettle={onSettle}
            onMove={onMove}
            onMeasure={onMeasure}
            refresh={refresh}
          />
        );
      })}
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
