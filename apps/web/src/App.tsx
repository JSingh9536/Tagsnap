import React from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './state/auth';
import { SignIn } from './pages/SignIn';
import { Queue } from './pages/Queue';
import { Review } from './pages/Review';
import { Periods } from './pages/Periods';
import { Rates } from './pages/Rates';
import { ROLE_LABEL } from '@tagsnap/shared';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AuthProvider>
  );
}

function Shell() {
  const { loading, profile, signOut } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="boot">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!profile) return <SignIn />;

  return (
    <div className="app">
      <nav className="nav">
        <Link to="/queue" className="nav__brand">
          TagSnap <span>Office</span>
        </Link>
        <div className="nav__links">
          <Link
            to="/queue"
            className={location.pathname.startsWith('/queue') ? 'on' : ''}
          >
            Review queue
          </Link>
          <Link
            to="/periods"
            className={location.pathname.startsWith('/periods') ? 'on' : ''}
          >
            Close &amp; invoices
          </Link>
          {/*
            Shown to office as well as admin. Office cannot change a rate —
            rates_admin_write in 002 refuses the write — but being able to read
            the book is how a reviewer answers "why was this priced at that?"
            without asking the owner. The page says plainly which of the two
            they are.
          */}
          <Link
            to="/rates"
            className={location.pathname.startsWith('/rates') ? 'on' : ''}
          >
            Rates
          </Link>
        </div>
        <div className="nav__user">
          <span>
            {profile.full_name}
            <em>{ROLE_LABEL[profile.role]}</em>
          </span>
          <button className="btn btn--ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </nav>

      <Routes>
        <Route path="/queue" element={<Queue />} />
        <Route path="/review/:id" element={<Review />} />
        <Route path="/periods" element={<Periods />} />
        <Route path="/rates" element={<Rates />} />
        <Route path="*" element={<Navigate to="/queue" replace />} />
      </Routes>
    </div>
  );
}
