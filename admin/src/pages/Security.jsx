import { Navigate } from 'react-router-dom';

// 2FA was removed platform-wide, so the admin Security console is retired.
// The route + sidebar link are gone; this stub only guards any stale deep link
// by redirecting to the dashboard.
export default function Security() {
  return <Navigate to="/dashboard" replace />;
}
