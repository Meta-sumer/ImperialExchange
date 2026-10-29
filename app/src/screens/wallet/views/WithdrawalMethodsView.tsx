/**
 * The Wallet hub's "Withdrawal Methods" view.
 *
 * The component lives in components/wallet/WithdrawalMethods.tsx because it
 * shares its fetch with WithdrawalMethodPicker, which the Withdraw view and
 * the Main / Bonus wallet withdraw sheet also render. Re-exported here so the
 * hub's views sit side by side (CONTRACT §13).
 */
export { WithdrawalMethodsView } from '@/components/wallet/WithdrawalMethods';
