import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * The overlay layer every modal, sheet, confirm and toast renders into —
 * this app's `createPortal(…, document.body)`.
 *
 * ── WHY NOT React Native's <Modal> ────────────────────────────────────
 * The web's Modal.jsx exists to make stacking deterministic: every overlay
 * goes to one place, ordered by a single z-index scale (modalLayers.js), so
 * a Rename modal opened from the watchlist manager sits above it and a
 * confirm opened from either sits above both.
 *
 * RN's native <Modal> gives that up. On iOS each one is a separately
 * presented view controller, and two SIBLING modals cannot be presented at
 * once — the second is dropped with a console warning. ConfirmProvider is a
 * sibling of every screen by construction, so `await confirm(…)` from inside
 * an open modal would silently never show, and the promise would never
 * settle. That is the exact case the web's layering was built for.
 *
 * So overlays are ordinary views in one host above the navigator, sorted by
 * the same Z scale. The cost is the usual portal cost: content renders in
 * the host's React tree, so it sees the APP-level providers (theme,
 * navigation container, confirm, toasts) but not a context a screen created
 * for itself. Pass such values in as props.
 * ──────────────────────────────────────────────────────────────────────
 */

interface Entry {
  key: string;
  z: number;
  /** Mount order, to keep equal-z overlays in the order they opened. */
  seq: number;
  node: ReactNode;
}

interface PortalApi {
  mount: (key: string, z: number, node: ReactNode) => void;
  update: (key: string, z: number, node: ReactNode) => void;
  unmount: (key: string) => void;
}

const PortalContext = createContext<PortalApi | null>(null);

/** Sort key: by layer, then by who opened first. Exported for tests. */
export const orderEntries = <T extends { z: number; seq: number }>(entries: T[]): T[] =>
  [...entries].sort((a, b) => (a.z - b.z) || (a.seq - b.seq));

export function PortalHost({ children }: { children: ReactNode }): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  const seq = useRef(0);

  const mount = useCallback((key: string, z: number, node: ReactNode) => {
    seq.current += 1;
    const s = seq.current;
    setEntries((prev) => [...prev.filter((e) => e.key !== key), { key, z, seq: s, node }]);
  }, []);

  const update = useCallback((key: string, z: number, node: ReactNode) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, z, node } : e)));
  }, []);

  const unmount = useCallback((key: string) => {
    setEntries((prev) => prev.filter((e) => e.key !== key));
  }, []);

  const api = useMemo<PortalApi>(() => ({ mount, update, unmount }), [mount, update, unmount]);

  return (
    <PortalContext.Provider value={api}>
      <View style={styles.flex}>{children}</View>
      {orderEntries(entries).map((e) => (
        <View
          key={e.key}
          pointerEvents="box-none"
          // elevation as well as zIndex: Android orders siblings by elevation
          // before zIndex, so without it a card with a shadow in the screen
          // below could draw over an overlay.
          style={[StyleSheet.absoluteFill, { zIndex: e.z, elevation: e.z }]}
        >
          {e.node}
        </View>
      ))}
    </PortalContext.Provider>
  );
}

/**
 * Render `children` in the overlay layer at `z` (see theme `Z`). Unmounting
 * the Portal removes it. Without a host (a unit test rendering one
 * component) it renders in place, so a component that uses a modal is still
 * testable on its own.
 */
export function Portal({ z, children }: { z: number; children: ReactNode }): React.JSX.Element | null {
  const host = useContext(PortalContext);
  const key = useId();

  // Mount once and unmount on the way out; the effect below pushes updates.
  useLayoutEffect(() => {
    if (!host) return undefined;
    host.mount(key, z, children);
    return () => host.unmount(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, key]);

  // Every render of the owner hands the host the latest element, so state
  // inside the modal's owner reaches the modal as it would with createPortal.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    host?.update(key, z, children);
  });

  if (!host) return <>{children}</>;
  return null;
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
