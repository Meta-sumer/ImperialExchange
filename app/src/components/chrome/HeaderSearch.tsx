import React, { useCallback, useState } from 'react';

import { IconButton } from '@/components/ui';

import { SearchModal } from './SearchModal';

/**
 * The header's search — Layout.jsx:396-403 (the phone header's search icon,
 * `aria-label="Open search"`) and the SearchModal it opens. For the
 * HeaderSearch chrome slot.
 *
 * native-stack draws one header per screen, so there is one of these per
 * screen in the stack; each owns a closed sheet that renders nothing and
 * runs no hooks until it is opened.
 */
export function HeaderSearch(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <IconButton name="search" accessibilityLabel="Open search" onPress={() => setOpen(true)} />
      <SearchModal open={open} onClose={close} />
    </>
  );
}
