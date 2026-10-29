/**
 * Imperial Exchange brand logo — the full artwork (eye mark + "IMPERIAL
 * EXCHANGE" wordmark + "Trade · Invest · Grow" tagline) on its navy ground.
 * `size` is the RENDERED HEIGHT; width follows the art's 6:5 aspect ratio.
 *
 * The art carries its own background, so one image serves both light and
 * dark surfaces (no theme variant). The brand name is part of the image —
 * do NOT add a separate "Imperial Exchange" text next to it.
 */
export default function BrandLogo({ size = 36, className = '', title = 'Imperial Exchange' }) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`brand-logo ${className}`}
      style={{ height: size, aspectRatio: '6 / 5', display: 'inline-block' }}
    />
  );
}
