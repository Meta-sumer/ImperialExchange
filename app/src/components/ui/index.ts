/**
 * The UI kit. Import from '@/components/ui', never from the files inside —
 * the catalogue with one-line usage for each is in docs/CONTRACT.md.
 */

// Layout
export { Screen, ScreenChromeContext, useScreenChrome, type ScreenChrome, type ScreenProps } from './Screen';
export { Card, type CardProps } from './Card';
export { Divider } from './Divider';
export { PageHero } from './PageHero';

// Type and icons
export { AppText, type AppTextProps, type TextTone, type TextVariant } from './AppText';
export { Icon, ICON_NAMES, type IconName, type IconProps } from './Icon';
export { BrandLogo } from './BrandLogo';
export { AssetIcon, type AssetIconProps } from './AssetIcon';
export { resolveAssetIcon, inferBaseFromSymbol, tileColor, type AssetIconSpec } from './assetIconResolve';
export { CountryFlag, flagCode } from './CountryFlag';

// Controls
export { Button, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { Input, PasswordInput, type InputProps } from './Input';
export { Select, filterOptions, type SelectOption, type SelectProps } from './Select';
export { Segmented, type SegmentOption, type SegmentedProps } from './Segmented';
export { Tabs, type TabItem, type TabsProps } from './Tabs';
export { Toggle, SwitchRow, Checkbox } from './Switch';

// Data display
export { Badge, Pill, type BadgeProps, type BadgeTone } from './Badge';
export { KeyValueRow, StatTile, MenuItem, SectionHeader } from './DataDisplay';

// States
export { LoadingView, ErrorView, EmptyState, Skeleton, SkeletonText, Spinner } from './States';
export { ErrorBoundary, errorIdFor } from './ErrorBoundary';

// Overlays
export { PortalHost, Portal } from './Portal';
export { Modal, BottomSheet, type ModalProps, type ModalSize } from './Modal';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
export {
  ConfirmProvider,
  useConfirm,
  normaliseConfirm,
  type ConfirmFn,
  type ConfirmOptions,
} from './ConfirmProvider';
export { ToastHost } from './ToastHost';
export { toast, orderToast, type ToastOptions, type ToastType } from './toast';
