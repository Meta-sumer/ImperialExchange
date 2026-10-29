import BrandLogo from './BrandLogo';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import Layout from './Layout';
import CmsFooter from './CmsFooter';

/**
 * Chrome for public CMS / news pages.
 *   • Logged-in user → the FULL app Layout (same header/sidebar as every other
 *     page) so CMS/News feel native to the app.
 *   • Anonymous visitor → a minimal public header + the CMS-driven footer.
 */
export default function PublicShell({ children }) {
  const { user } = useAuthStore();

  if (user) return <Layout>{children}</Layout>;

  return (
    <div className="min-h-screen flex flex-col bg-bg-dark">
      <header className="border-b border-border-dark">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center shrink-0">
            <BrandLogo size={48} />
          </Link>
          <Link to="/login" className="btn-primary text-sm px-4 py-1.5">Sign In</Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <CmsFooter />
    </div>
  );
}
