import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Z } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * The confirm dialog as a controlled component — ConfirmProvider.jsx's
 * markup, for the cases where a screen wants to own the open state (a
 * confirm with a loading state while the request runs). For the everyday
 * `if (await confirm(…))` use `useConfirm()` instead.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** Disables both buttons and spins Confirm, e.g. while the request runs. */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  zIndex?: number;
}

export function ConfirmDialog({
  open,
  title = 'Please confirm',
  message = 'Are you sure?',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
  zIndex = Z.critical,
}: ConfirmDialogProps): React.JSX.Element | null {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      dismissible={!loading}
      title={title}
      // max-w-sm, and Modal's own breakpoint: a sheet on a phone, a centred
      // card on a tablet — ConfirmProvider.jsx renders through Modal.jsx and
      // gets exactly that.
      size="sm"
      zIndex={zIndex}
      footer={(
        <View style={styles.actions}>
          <Button variant="secondary" title={cancelText} onPress={onCancel} disabled={loading} />
          <Button
            variant={danger ? 'danger' : 'primary'}
            title={confirmText}
            onPress={onConfirm}
            loading={loading}
          />
        </View>
      )}
    >
      {/* whitespace-pre-line: RN Text keeps newlines as written. */}
      <AppText variant="body" tone="secondary">{message}</AppText>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
