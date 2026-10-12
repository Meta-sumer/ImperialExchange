import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuthStore, errorMessage } from '../store/auth';
import BrandMark from '../components/BrandMark';
import AuthShell from '../components/AuthShell';
import PasswordInput from '../components/PasswordInput';
import { v, sanitize } from '../utils/validation';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // Field-level errors keyed by field name. Cleared as the user types
  // a valid value, set on blur / submit.
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});

  const { login } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/explore';

  const validate = () => {
    const next = {
      email:    v.email(email),
      password: v.password(password),
    };
    const cleaned = Object.fromEntries(Object.entries(next).filter(([_, val]) => val));
    setErrors(cleaned);
    return Object.keys(cleaned).length === 0;
  };

  const onBlur = (field) => () => {
    setTouched((t) => ({ ...t, [field]: true }));
    validate();
  };

  const showError = (field) => touched[field] && errors[field];

  const handleSubmit = async (e) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (!validate()) return;
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      toast.success('Welcome back');
      navigate(from, { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <div className="card p-8 w-full max-w-md">
        <div className="text-center mb-7">
          <BrandMark />
          <p className="text-sm text-text-secondary mt-3">Sign in to your trading account</p>
        </div>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {/* Email — strict format, auto-lowercase, trimmed */}
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className={`input ${showError('email') ? 'border-bear focus:border-bear' : ''}`}
              value={email}
              onChange={(e) => setEmail(sanitize.email(e.target.value))}
              onBlur={onBlur('email')}
              required
              autoFocus
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              spellCheck={false}
              placeholder="you@example.com"
              aria-invalid={!!showError('email')}
              aria-describedby="email-err"
            />
            <FieldError id="email-err" msg={showError('email')} />
          </div>

          {/* Password */}
          <div>
            <label className="label">Password</label>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={onBlur('password')}
              required
              minLength={8}
              maxLength={128}
              autoComplete="current-password"
              aria-invalid={!!showError('password')}
            />
            <FieldError msg={showError('password')} />
            <div className="text-right mt-1">
              <Link to="/forgot-password" className="text-xs text-teal-accent hover:underline">Forgot password?</Link>
            </div>
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        <div className="mt-6 text-center text-sm text-gray-400">
          Don't have an account?{' '}
          <Link to="/register" className="text-primary-500 hover:text-primary-600">
            Create one
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}

// Inline field-level error pill — kept its own component because three
// fields need the same treatment.
function FieldError({ id, msg }) {
  if (!msg) return null;
  return (
    <div
      id={id}
      className="mt-1 text-[11px] text-bear font-semibold flex items-center gap-1"
      role="alert"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      {msg}
    </div>
  );
}
