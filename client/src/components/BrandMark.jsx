import BrandLogo from './BrandLogo';

/**
 * Brand block for the auth-flow pages (Login, Register, ForgotPassword,
 * ResetPassword, VerifyEmail) so the brand never visually drifts.
 *
 * This used to draw a hand-rolled gold "T" tile next to the word "TradePro" —
 * placeholder branding that survived everywhere the real Imperial Exchange lockup was
 * never wired in. It now renders the same asset the main header uses, so the
 * sign-in screen and the app agree.
 *
 * The wordmark is PART of the lockup image, so nothing prints the brand name
 * as text beside it. `wordmark={false}` shows the eye mark alone
 * (VerifyEmail, where the heading already carries the name).
 */
export default function BrandMark({ size = 'md', wordmark = true }) {
  if (!wordmark) {
    const px = size === 'lg' ? 56 : 48;
    return (
      <span
        role="img"
        aria-label="Imperial Exchange"
        title="Imperial Exchange"
        className="brand-mark inline-block align-middle"
        style={{ height: px, width: px }}
      />
    );
  }
  // Rendered HEIGHT; width follows the lockup's own aspect ratio.
  return <BrandLogo size={size === 'lg' ? 120 : 100} className="align-middle" />;
}
