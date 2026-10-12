/**
 * Frexever brand logo — the full combined lockup (circular-arrows icon +
 * "Frexever" wordmark + "Trade Free Forever" tagline), transparent PNG.
 * `size` is the RENDERED HEIGHT; width scales via the image aspect ratio.
 *
 * Theme-aware: the `.brand-logo` CSS (index.css) shows the dark-text art on
 * light surfaces and swaps to the white-text art under [data-theme='dark'], so
 * the wordmark stays readable on both. The brand name is part of the image —
 * do NOT add a separate "Frexever" text next to it.
 */
export default function BrandLogo({ size = 36, className = '', title = 'Frexever' }) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`brand-logo ${className}`}
      style={{ height: size, aspectRatio: '2500 / 874', display: 'inline-block' }}
    />
  );
}
